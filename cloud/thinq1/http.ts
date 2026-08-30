import { Request, Response, Router } from 'express'
import fetch from 'node-fetch'
import * as HTTPS from 'node:https'
import { Config } from '@/util/config'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'
import { Metadata } from '../thinq'
import log from '@/util/logging'
import { CourseCache } from './course-cache'
import { synthesizeLocalCourse } from './course-synthesis'

// Raw pre-parse request bytes, stashed by xmlParser() below so proxyToLG() can forward a
// device's request to LG byte-for-byte instead of rebuilding XML from the parsed object -
// parsing then rebuilding is lossy (e.g. fast-xml-parser silently turns "0012" into the
// number 12, dropping the leading zeros LG's own catalog lookups may depend on).
declare module 'express' {
    interface Request {
        rawBody?: Buffer
    }
}

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

// The fixed, non-personal device-API credential every real ThinQ1 device uses to talk to LG
// (not the user's account token) - already proven working in bridge/thinq1connection.ts's own
// TotalDeviceInfoSvc call during bridge startup. Reused here to proxy a couple of endpoints we
// don't understand well enough to fabricate a correct response for.
const LG_DEVICE_AUTH = {
    'x-lgedm-userid': 'lgehadmUser',
    'x-lgedm-password': 'bxLoLAZ+rp3oJDbEzRuIfAG4YumeqwWM9l6uUH6TupQ=',
}

// Forwards a device's request to the real LG server and returns its response verbatim, but
// only while this device is actively bridged right now (see Bridge.activeHttpServer) - not a
// permanent cloud dependency, just a capture tool for endpoints whose real response we don't
// know yet. Returns null (caller should fall back to its own best-guess response) if there's
// no active bridge for this device, or the proxy call itself fails.
//
// Forwards req's real raw body and real headers (minus the hop-by-hop ones that must
// legitimately differ across a new connection) rather than reconstructing them - a device's
// actual request is the only thing guaranteed to look exactly like what LG expects.
async function proxyToLG(
    getActiveHttpServer: ((deviceId: string) => string | undefined) | undefined,
    deviceId: string | undefined,
    req: Request,
): Promise<string | null> {
    const httpServer = deviceId && getActiveHttpServer?.(deviceId)
    if (!httpServer || !req.rawBody) return null

    const {
        host: _host,
        connection: _connection,
        'content-length': _cl,
        'transfer-encoding': _te,
        ...forwardedHeaders
    } = req.headers

    try {
        const resp = await fetch(httpServer + req.path, {
            method: 'POST',
            headers: {
                ...(forwardedHeaders as Record<string, string>),
                ...LG_DEVICE_AUTH,
                'x-lgedm-deviceid': deviceId,
            },
            body: req.rawBody,
            agent: new HTTPS.Agent({ keepAlive: true, rejectUnauthorized: false }),
        })
        const text = await resp.text()
        log('HTTPS', `proxied ${req.method} ${req.path} ${deviceId} -> ${resp.status} ${text}`)
        return text
    } catch (err) {
        log('HTTPS', `proxying ${req.method} ${req.path} ${deviceId} failed: ${err}`)
        return null
    }
}

// Where WasherCourseDownloadSvc's fabricated downUrl points once a course is cached locally -
// see cloud/thinq1/course-cache.ts.
const COURSE_DOWNLOAD_PATH = '/api/webContents/courseDownload'

// modelName is only included so the GET handler below can resolve a locally-synthesized
// course (see cloud/thinq1/course-synthesis.ts) without needing to know which device asked -
// the device's later GET to this URL may not carry any deviceId-identifying header at all.
function localCourseUrl(config: Config, courseId: string, modelName: string | undefined): string {
    const model = modelName ? `&model=${encodeURIComponent(modelName)}` : ''
    return `https://${config.hostname}:${config.thinq1_https_port.advertise}${COURSE_DOWNLOAD_PATH}?courseId=${encodeURIComponent(courseId)}${model}`
}

// Pulls a single top-level tag's text content out of a real LG XML response via regex rather
// than XMLParser/XMLBuilder - a parse-then-rebuild round trip is exactly what corrupted
// proxyToLG's requests before (see its own comment above); this only needs one field read out
// and one field substituted back in, so a plain string operation keeps everything else in the
// real response byte-for-byte untouched.
function extractXmlTag(xml: string, tag: string): string | undefined {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
    return match?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

// Fetches a course's real content directly from LG (server-to-server - the device never sees
// this request), so it can be cached and replayed locally afterwards. Real LG's cert here is
// presumably fine to validate normally, but proxyToLG already established that LG's
// device-facing infrastructure doesn't always present publicly-trusted certs, so this mirrors
// its rejectUnauthorized:false for consistency rather than risking an avoidable capture failure.
async function captureCourseContent(url: string): Promise<{ contentType: string; body: Buffer } | null> {
    try {
        const resp = await fetch(url, { agent: new HTTPS.Agent({ keepAlive: true, rejectUnauthorized: false }) })
        if (!resp.ok) {
            log('HTTPS', `course content fetch failed: ${url} -> ${resp.status}`)
            return null
        }
        const body = Buffer.from(await resp.arrayBuffer())
        const contentType = resp.headers.get('content-type') ?? 'application/octet-stream'
        log('HTTPS', `captured course content: ${url} -> ${resp.status} ${contentType} (${body.length} bytes)`)
        return { contentType, body }
    } catch (err) {
        log('HTTPS', `course content fetch failed: ${url}: ${err}`)
        return null
    }
}

const deviceMeta: Record<string, Metadata> = {}
export function getDeviceMetadata(id: string) {
    return deviceMeta[id]
}

// diagMonData is base64 of either a plain decimal string (e.g. ScomoCourse's course id) or
// XML (WasherMonitoring's tubInfo/courseInfo/energyMonInfo) — try XML first, fall back to
// the raw decoded string.
function decodeDiagMonData(b64: string): unknown {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x3c /* '<' */) {
        try {
            return new XMLParser().parse(raw)
        } catch {
            // fall through to the raw string below
        }
    }
    return raw.toString('utf-8')
}

function xmlParser(req: Request, res: Response, next: () => void) {
    const buffers: Buffer[] = []
    let length = 0
    let error = false

    req.on('data', (data) => {
        if (!error) {
            buffers.push(data)
            length += data.length
            if (length > 1000000) {
                res.status(400).end()
                error = true
            }
        }
    })

    req.on('end', () => {
        if (!error) {
            req.rawBody = Buffer.concat(buffers)
            req.body = new XMLParser().parse(req.rawBody)
            next()
        }
    })
}

export function routes(
    config: Config,
    onDiagmon?: (deviceId: string, diagMonType: string, decoded: unknown) => void,
    getActiveHttpServer?: (deviceId: string) => string | undefined,
) {
    const router = Router()
    // Only populated when bridge is configured - that's also the only way to ever capture a
    // course's real content in the first place. Files persist under bridge's own storage dir.
    const courseCache = config.bridge ? new CourseCache(config.bridge.storage_path) : undefined

    router.use(xmlParser)

    router.post('/lgehadm/api/Device/TotalDeviceInfoSvc', (req, res) => {
        const response: any = {
            returnCd: '0000',
            returnMsg: 'OK',
        }

        const deviceId = req.header('x-lgedm-deviceid')
        const deviceType = req.header('x-lgedm-devicetype')
        const modelName = req.body?.lgedmRoot?.modelName
        if (!deviceId) return res.status(400).end()

        // Answered entirely locally below, always, regardless of bridge state - unlike
        // WasherCourseDownloadSvc this never logged its own body, so there's no visibility into
        // what the device is actually asking for/reporting here. Fires on a regular periodic
        // cadence (unlike the one-shot course-download exchange), which makes it a real
        // candidate for whatever LG's app polls to refresh its own display - logging the full
        // body to find out, rather than guessing.
        log('HTTPS', `TotalDeviceInfoSvc ${deviceId}: ${JSON.stringify(req.body)}`)

        if (modelName && deviceType)
            deviceMeta[deviceId] = {
                deviceType,
                modelId: modelName,
                modelName,
            }

        if (req.body?.lgedmRoot?.itemList?.item === 'DM_SETTING_INFO_GET_URI') {
            response.itemList = {
                elementList: {
                    elementCode: 'settingInfoList',
                    elementValueList: {
                        code: 'BlackBox',
                        value: 'N',
                    },
                },
                item: 'DM_SETTING_INFO_GET_URI',
                returnCode: '0000',
            }
        } else if (req.body?.lgedmRoot?.itemList?.item === 'THINQ_TIME_SYNC_URI') {
            response.itemList = {
                elementList: [
                    {
                        elementCode: 'utcTime',
                        elementValue: new Date()
                            .toISOString()
                            .replace(/T|\....Z/g, ' ')
                            .trim(),
                    },
                    {
                        elementCode: 'timezone',
                        elementValue: 0,
                    },
                ],
                item: 'THINQ_TIME_SYNC_URI',
                returnCode: '0000',
            }
        }

        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: response }))
    })

    router.post('/lgehadm/api/Rtos/ContentsVerSvc', async (req, res) => {
        // Called on every single connect, before anything else - looks like a "what
        // course-catalog content version do you have" handshake. We don't know what a correct
        // answer looks like, so proxy to the real LG server while actively bridged and hand
        // back its real response instead of guessing; otherwise fall back to a generic OK.
        const deviceId = req.header('x-lgedm-deviceid')
        log('HTTPS', `ContentsVerSvc ${deviceId}: ${JSON.stringify(req.body)}`)

        const proxied = await proxyToLG(getActiveHttpServer, deviceId, req)
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(proxied ?? XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    router.post('/lgehadm/api/Grid/PowerSavingInfoSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0108', returnMsg: 'No Saving Data.' } }))
    })

    router.post('/lgehadm/api/Rtos/FWInfoSettingSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    router.post('/lgehadm/report/diagmon', (req, res) => {
        // Per-cycle energy/water usage and tub-clean-alert reports arrive here
        // (WasherMonitoring diagMonType), separate from the periodic Mon/Start status
        // channel. diagMonData is double-encoded (base64 of either a plain string or XML,
        // which may itself contain further base64 fields) — decode what we can generically
        // here and hand it to the matching device, which knows what its fields mean.
        // Unlike every other lgehadm endpoint, this one doesn't send x-lgedm-deviceid —
        // the device id only exists inside the body, as Report.devId.
        const report = req.body?.Report
        const deviceId = req.header('x-lgedm-deviceid') ?? report?.devId
        if (deviceId && typeof report?.diagMonType === 'string' && typeof report?.diagMonData === 'string') {
            const decoded = decodeDiagMonData(report.diagMonData)
            log('HTTPS', `diagmon ${deviceId} ${report.diagMonType}: ${JSON.stringify(decoded)}`)
            onDiagmon?.(deviceId, report.diagMonType, decoded)
        } else {
            log('HTTPS', `diagmon ${deviceId}: ${JSON.stringify(req.body)}`)
        }
        res.end()
    })

    router.post('/lgehadm/api/Rtos/WasherCourseDownloadSvc', async (req, res) => {
        // selectedCd is the course reference code the device already got from the app over
        // the persistent socket (InfoAlarm/CmdOpt:Course, base64 XML) - not raw course data,
        // a lookup against LG's real course-catalog backend. Confirmed live: real LG returns
        // a downUrl at aic.lgthinq.com (a different, non-DNS-rewritten host - the actual
        // content fetch normally happens directly against real LG, invisible to rethink)
        // followed by the device hitting CourseDownloadCompleteSvc below - a full real
        // SmartCourse download.
        //
        // Three ways this can be answered, checked in order, all without a live proxy if
        // possible:
        // 1. Locally synthesized (cloud/thinq1/course-synthesis.ts) - a device class already
        //    knows this course's real parameters (from modelJson), so we can build a correct
        //    payload ourselves with zero LG dependency, ever.
        // 2. Already cached from a real capture (below) - a previous real download for this
        //    exact courseId was captured and stored.
        // 3. Neither - proxy the lookup to real LG as before, and if it returns a downUrl,
        //    additionally fetch that URL ourselves (server-to-server, the device never sees
        //    this extra request - see captureCourseContent), cache the result, and rewrite
        //    the URL we hand the device to point at ourselves. Falls back to relaying LG's
        //    real response unmodified if anything about the capture fails, so this can never
        //    make a working download worse.
        const deviceId = req.header('x-lgedm-deviceid')
        log('HTTPS', `WasherCourseDownloadSvc ${deviceId}: ${JSON.stringify(req.body)}`)

        const rawCourseId = req.body?.lgedmRoot?.selectedCd
        const courseId = rawCourseId !== undefined ? String(rawCourseId) : undefined
        const modelName = deviceId ? deviceMeta[deviceId]?.modelName : undefined

        const locallyAvailable = courseId && (synthesizeLocalCourse(modelName, courseId) || courseCache?.get(courseId))
        if (courseId && locallyAvailable) {
            log('HTTPS', `WasherCourseDownloadSvc ${deviceId}: serving course ${courseId} locally`)

            // Best-effort mirror: answering the device locally means real LG never sees this
            // request, so its own course-download bookkeeping goes stale - the app keeps
            // showing whatever course was last *actually* proxied, even though the device (and
            // rethink's own SmartCourse entity, which reads the device's real status bytes) has
            // moved on. Fired in the background, not awaited, so a slow or absent bridge never
            // delays the device's own answer. proxyToLG() already no-ops safely if this device
            // isn't currently bridged, and already logs/catches its own failures - nothing more
            // to do here. CourseDownloadCompleteSvc below already unconditionally forwards the
            // device's real completion ack to LG regardless of which path answered this call,
            // so mirroring just this first request is enough to complete the same handshake
            // real LG expects from an actual download.
            void proxyToLG(getActiveHttpServer, deviceId, req)

            res.header('Content-type: text/xml;charset=utf-8')
            res.end(
                XML_HEADER +
                    new XMLBuilder().build({
                        lgedmRoot: {
                            returnCd: '0000',
                            returnMsg: 'OK',
                            verName: courseId,
                            downUrl: localCourseUrl(config, courseId, modelName),
                        },
                    }),
            )
            return
        }

        const proxied = await proxyToLG(getActiveHttpServer, deviceId, req)
        if (proxied && courseId && courseCache) {
            const realDownUrl = extractXmlTag(proxied, 'downUrl')
            // Cached in the background for course-cache.ts's fallback (a future
            // locally-unsynthesizable course) - no longer used to rewrite the response below.
            // This used to hand the device a downUrl pointing at rethink's own local mirror
            // instead of LG's real one, meaning the device never actually fetched content from
            // LG's real infrastructure even on a fully-proxied download. Whether LG's own
            // backend needs to see that real fetch happen to consider a download "confirmed" is
            // unconfirmed, but it's a real, testable difference from a genuine device<->LG
            // conversation - the device now gets LG's real response verbatim below. Not awaited:
            // populating our own cache is unrelated to what the device needs right now.
            if (realDownUrl) {
                captureCourseContent(realDownUrl).then((captured) => {
                    if (captured) courseCache.set(courseId, captured.contentType, captured.body)
                })
            }
        }

        res.header('Content-type: text/xml;charset=utf-8')
        res.end(proxied ?? XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    router.get(COURSE_DOWNLOAD_PATH, (req, res) => {
        const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : undefined
        const modelName = typeof req.query.model === 'string' ? req.query.model : undefined
        // Checks synthesis first, deliberately independent of deviceId/deviceMeta - this GET
        // is the device fetching a URL we handed it earlier and may not identify itself the
        // same way its lgehadm POSTs do, so modelName travels in the URL itself instead.
        const cached = courseId && (synthesizeLocalCourse(modelName, courseId) || courseCache?.get(courseId))
        if (!cached) {
            res.status(404).end()
            return
        }
        res.header('content-type', cached.contentType)
        res.end(cached.body)
    })

    router.post('/lgehadm/api/Rtos/CourseDownloadCompleteSvc', async (req, res) => {
        // Sent once the device finishes fetching the real course content from the downUrl
        // WasherCourseDownloadSvc handed back (workId matches that call's selectedCd) - an ack
        // that the download completed, not a data transfer itself. First seen via the generic
        // catch-all below; promoted to a named handler now that it's understood.
        const deviceId = req.header('x-lgedm-deviceid')
        log('HTTPS', `CourseDownloadCompleteSvc ${deviceId}: ${JSON.stringify(req.body)}`)

        const proxied = await proxyToLG(getActiveHttpServer, deviceId, req)
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(proxied ?? XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    router.post('/api/product/sendPushMessage', (req, res) => {
        // Not yet decoded — this is the device's own push-notification channel
        // (messageCode/langCode), the likely source of "cycle complete"/error events that
        // don't fit into the periodic Mon/Start status. Previously unhandled entirely (fell
        // through to the generic {} JSON fallback instead of a real XML ack). Log the body
        // so a real notification can be captured and turned into an HA event.
        log('HTTPS', `sendPushMessage ${req.header('x-lgedm-deviceid')}: ${JSON.stringify(req.body)}`)
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    // Catch-all for anything not explicitly handled above. Previously these fell all the way
    // through to rethink-cloud.ts's generic `res.json({})` fallback, silently — no log line,
    // no real ack, easy to miss real traffic entirely (this is exactly how ContentsVerSvc and
    // WasherCourseDownloadSvc went unnoticed for as long as they did). Two things this buys us:
    // - Every unknown endpoint now gets logged with its full method/path/body, so discovering
    //   a new one is a matter of watching the HTTPS log topic, not stumbling onto it.
    // - While actively bridged, unknown endpoints get proxied to the real LG server and its
    //   real response relayed back, instead of a guessed generic ack - the same technique
    //   already proven for ContentsVerSvc/WasherCourseDownloadSvc, generalized so every future
    //   unknown endpoint gets it automatically rather than needing to be individually
    //   whitelisted first.
    router.use(async (req: Request, res: Response) => {
        const deviceId = req.header('x-lgedm-deviceid')
        log('HTTPS', `unhandled ${req.method} ${req.path} ${deviceId}: ${JSON.stringify(req.body)}`)

        const proxied = await proxyToLG(getActiveHttpServer, deviceId, req)
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(proxied ?? XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    return router
}
