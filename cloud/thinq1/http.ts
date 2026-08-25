import { Request, Response, Router } from 'express'
import fetch from 'node-fetch'
import * as HTTPS from 'node:https'
import { Config } from '@/util/config'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'
import { Metadata } from '../thinq'
import log from '@/util/logging'

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
        // The app sends {contents:"course", selectedCd:<catalog code>} - a lookup, not the
        // actual course data. Real content lives on LG's own course-catalog backend, which we
        // don't have; proxy to it while actively bridged so the app gets a real answer instead
        // of the empty ack that was producing "Cycle failed to download." Cross-check the real
        // response against modelJson's ControlWifi.action.CourseDownload (tag: COURSE/ID/DATA)
        // once captured - it may turn out to be derivable from our own SMART_COURSE table
        // instead of genuinely per-account content, which would let us serve it locally too.
        const deviceId = req.header('x-lgedm-deviceid')
        log('HTTPS', `WasherCourseDownloadSvc ${deviceId}: ${JSON.stringify(req.body)}`)

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
