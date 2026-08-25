import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express'

import path from 'path'
import { fileURLToPath } from 'url'
import log, { onLog } from '@/util/logging'

import HA_bridge from '@/cloud/ha_bridge'
import { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import { Bridge } from '@/bridge'
import { Request, Response } from 'express'
import { Device as T1Device } from '@/cloud/thinq1/device'
import { Device as T2Device } from '@/cloud/thinq2/device'
import { decodePacket } from '@/util/packet-codec'

export function app(ha: HA_bridge, manager: DeviceManager, bridge: Bridge | undefined) {
    const app = new WebSocketExpress()
    const subscribers = new Set<ExtendedWebSocket>()
    const deviceMonitors = new Map<ExtendedWebSocket, () => void>()
    const disposers: Array<() => void> = []
    let shuttingDown = false

    function closeQuietly(ws: ExtendedWebSocket) {
        try {
            ws.close()
        } catch {}
    }

    function safeSend(ws: ExtendedWebSocket, message: string) {
        if (ws.readyState !== ws.OPEN) return false
        try {
            ws.send(message, (error) => {
                if (error) {
                    subscribers.delete(ws)
                    closeQuietly(ws)
                }
            })
            return true
        } catch {
            subscribers.delete(ws)
            closeQuietly(ws)
            return false
        }
    }

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => safeSend(sub, str))
    }

    function statusReport(message: string) {
        broadcast({ status: message })
    }

    app.use(function (req, res, next) {
        log('MGMT', req.hostname, req.url)
        next()
    })
    app.use(WebSocketExpress.json())

    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }
            subscribers.add(ws)

            safeSend(
                ws,
                JSON.stringify({
                    ha: ha.HA.isConnected,
                    bridge: bridgeStatus(),
                    devices: enumDevices(),
                }),
            )

            ws.on('message', (msg) => {})

            ws.on('close', () => {
                subscribers.delete(ws)
            })
        }, next)
    })

    const onHaStatusChanged = (ha: boolean) => {
        broadcast({ ha })
    }
    ha.HA.on('statusChanged', onHaStatusChanged)
    disposers.push(() => ha.HA.removeListener('statusChanged', onHaStatusChanged))

    function enumDevices() {
        const allDevices: Record<string, any> = {}
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                model: meta.modelId,
                deviceType: meta.deviceType,
                platform: dev.platform,
                mapped: ha.haDevices.has(id),
                bridged: bridge ? bridge.status(id) : false,
            }
        }
        return allDevices
    }

    function refreshDevices() {
        broadcast({ devices: enumDevices() })
    }

    function onNewDevice(dev: AnyDevice) {
        refreshDevices()
    }

    manager.on('newDevice', onNewDevice)
    manager.on('dropDevice', refreshDevices)
    disposers.push(() => {
        manager.removeListener('newDevice', onNewDevice)
        manager.removeListener('dropDevice', refreshDevices)
    })

    if (bridge) {
        app.get(
            '/thinq_login',
            asyncHandler(async (req, res) => {
                res.redirect((await bridge.beginLogin({ countryCode: req.query.countryCode as string })).toString())
            }),
        )

        app.post(
            '/thinq_login_accept',
            asyncHandler(async (req, res) => {
                const url = `${req.body.url}`
                const countryCode = `${req.body.countryCode}`
                if (await bridge.completeLogin({ countryCode }, new URL(url))) {
                    res.statusCode = 200
                    res.end()
                } else {
                    res.statusCode = 400
                    res.end()
                }
            }),
        )

        app.post(
            '/thinq_logout',
            asyncHandler(async (req, res) => {
                await bridge.logout()
                res.end()
            }),
        )

        app.post(
            '/bridge/:deviceId/enable',
            asyncHandler(async (req, res) => {
                const deviceType = typeof req.body.deviceType === 'string' ? (req.body.deviceType as string) : undefined
                try {
                    if (await bridge.enable(req.params.deviceId, deviceType, statusReport)) res.status(204).end()
                    else res.status(400).end()
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.post(
            '/bridge/:deviceId/disable',
            asyncHandler(async (req, res) => {
                await bridge.disable(req.params.deviceId)
                res.status(204).end()
            }),
        )

        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() })
        }

        bridge.on('loggedIn', refreshBridgeStatus)
        bridge.on('loggedOut', refreshBridgeStatus)
        bridge.on('started', refreshDevices)
        bridge.on('stopped', refreshDevices)
        disposers.push(() => {
            bridge.removeListener('loggedIn', refreshBridgeStatus)
            bridge.removeListener('loggedOut', refreshBridgeStatus)
            bridge.removeListener('started', refreshDevices)
            bridge.removeListener('stopped', refreshDevices)
        })
    }

    function bridgeStatus() {
        if (bridge) return { loggedIn: bridge.isLoggedIn() }
    }

    // device monitoring
    app.ws('/device', (req, res, next) => {
        const id = req.query?.id
        if (typeof id !== 'string') {
            res.status(400).end()
            return
        }

        res.accept().then((ws) => {
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }
            let injectFlag = false
            let device: AnyDevice | undefined

            // decodePacket() never throws (unrecognized framing comes back as protocol:'unknown',
            // not an exception) and is already used by rethink-capture.ts/mcp-server.ts for the
            // exact same job - reused here so the monitor page can show decoded TLV/AABB fields
            // instead of raw hex, without needing to duplicate the decoding logic in the browser.
            // Only forwarded when decoding actually succeeded, to keep ThinQ1's own non-framed
            // status bytes (and anything else unrecognized) from cluttering the wire with a
            // 'decoded: {protocol: "unknown"}' the frontend would just discard anyway.
            function decodedOrUndefined(hex: string) {
                const decoded = decodePacket(hex)
                return decoded.protocol === 'unknown' ? undefined : decoded
            }

            const onDeviceRx = (arg: Buffer) => {
                const hex = arg.toString('hex')
                safeSend(ws, JSON.stringify({ rx: hex, injected: injectFlag, decoded: decodedOrUndefined(hex) }))
            }

            const onDeviceTx = (arg: Buffer | object) => {
                if (Buffer.isBuffer(arg)) {
                    const hex = arg.toString('hex')
                    safeSend(ws, JSON.stringify({ tx: hex, injected: injectFlag, decoded: decodedOrUndefined(hex) }))
                } else safeSend(ws, JSON.stringify({ tx: JSON.stringify(arg), injected: injectFlag }))
            }

            const checkDevicePresence = () => {
                const dev = manager.allDevices[id]

                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx)
                    device?.removeListener('sendData', onDeviceTx)

                    device = dev
                    if (device) {
                        safeSend(ws, JSON.stringify({ status: 'online', meta: device.meta }))
                        device.on('data', onDeviceRx)
                        device.on('sendData', onDeviceTx)
                    } else {
                        safeSend(ws, JSON.stringify({ status: 'offline' }))
                    }
                }
            }

            manager.on('newDevice', checkDevicePresence)
            manager.on('dropDevice', checkDevicePresence)

            checkDevicePresence()

            ws.on('message', (msg) => {
                if (!Buffer.isBuffer(msg)) return

                let json: any
                try {
                    json = JSON.parse(msg.toString('utf-8'))
                } catch {
                    return
                }
                const dev = manager.allDevices[id]

                try {
                    if (typeof json.sendToDevice === 'object' && dev && dev instanceof T1Device) {
                        try {
                            injectFlag = true
                            dev.send(json.sendToDevice)
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (typeof json.sendToDevice === 'string' && dev && dev instanceof T2Device) {
                        try {
                            injectFlag = true
                            dev.send_packet(Buffer.from(json.sendToDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (json.sendFromDevice && dev) {
                        try {
                            injectFlag = true
                            dev.emit('data', Buffer.from(json.sendFromDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }
                } catch (err) {
                    log('MGMT', id, `inject error: ${err}`)
                }
            })

            const cleanup = () => {
                if (!deviceMonitors.delete(ws)) return
                device?.removeListener('data', onDeviceRx)
                device?.removeListener('sendData', onDeviceTx)
                device = undefined
                manager.removeListener('newDevice', checkDevicePresence)
                manager.removeListener('dropDevice', checkDevicePresence)
            }
            deviceMonitors.set(ws, cleanup)
            ws.once('close', cleanup)
            ws.once('error', cleanup)
        }, next)
    })

    // activity log - opt-in, topic-filterable feed of log() calls, for the management panel's
    // live activity view. Unlike /device (always-on for the whole session), a client only
    // starts receiving anything the moment it connects here and stops the instant it
    // disconnects - nothing is broadcast to /ws by default, since an actively-bridged device
    // can log several lines a second and most connected clients aren't watching for it.
    const logMonitors = new Map<ExtendedWebSocket, () => void>()
    app.ws('/logs', (req, res, next) => {
        res.accept().then((ws) => {
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }

            // ?topics=HTTPS,bridge restricts the feed; omitted means everything.
            const topicsParam = req.query?.topics
            const topics =
                typeof topicsParam === 'string' && topicsParam.length > 0
                    ? new Set(
                          topicsParam
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean),
                      )
                    : undefined

            const unsubscribe = onLog((ts, topic, args) => {
                if (topics && !topics.has(topic)) return
                safeSend(ws, JSON.stringify({ ts, topic, text: formatLogArgs(args) }))
            })

            const cleanup = () => {
                if (!logMonitors.delete(ws)) return
                unsubscribe()
            }
            logMonitors.set(ws, cleanup)
            ws.once('close', cleanup)
            ws.once('error', cleanup)
        }, next)
    })

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    const server = app.createServer()

    const dispose = () => {
        if (shuttingDown) return
        shuttingDown = true
        for (const dispose of disposers.splice(0)) dispose()
        for (const subscriber of subscribers) closeQuietly(subscriber)
        subscribers.clear()
        for (const [monitor, cleanup] of deviceMonitors) {
            cleanup()
            closeQuietly(monitor)
        }
        deviceMonitors.clear()
        for (const [monitor, cleanup] of logMonitors) {
            cleanup()
            closeQuietly(monitor)
        }
        logMonitors.clear()
    }

    const close = server.close.bind(server)
    server.close = ((callback?: (err?: Error) => void) => {
        dispose()
        return close(callback)
    }) as typeof server.close
    server.once('close', dispose)
    return server
}

function formatLogArgs(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === 'string') return a
            try {
                return JSON.stringify(a)
            } catch {
                return String(a)
            }
        })
        .join(' ')
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response, next: (err: any) => void) => {
        handler(req, res).catch(next)
    }
}
