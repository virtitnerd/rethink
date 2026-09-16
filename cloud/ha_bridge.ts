import { readdirSync } from 'node:fs'
import { Device as T1Device } from './thinq1/device'
import { Device as T2Device } from './thinq2/device'
import { type Connection } from './homeassistant'
import HADevice from './devices/base'
import { type Metadata } from './thinq'
import { AnyDevice } from './devmgr'

type T1Factory = new (HA: Connection, thinq: T1Device, metadata: Metadata) => HADevice
type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t1deviceTypes: Record<string, T1Factory> = {}
const t2deviceTypes: Record<string, T2Factory> = {}

// Every real device handler in ./devices registers itself here just by existing, provided it
// exports `platform` ('thinq1' or 'thinq2') alongside its default class - the modelId is its
// filename, and a class serving more than one modelId (a compatible variant, a typo'd model
// string LG ships, etc.) adds the extras via an `aliases` export instead of a second file. A
// file with no `platform` export is a shared base module (base.ts, tlv_device.ts,
// washer_common.ts, ...), not a device, and is skipped - this is also why one is never
// mistaken for the other here.
const devicesDir = new URL('./devices', import.meta.url)
for (const file of readdirSync(devicesDir)) {
    if (!/\.(ts|js)$/.test(file) || file.endsWith('.d.ts')) continue

    const mod = await import(`./devices/${file}`)
    if (mod.platform !== 'thinq1' && mod.platform !== 'thinq2') continue

    const registry = mod.platform === 'thinq1' ? t1deviceTypes : t2deviceTypes
    const modelId = file.replace(/\.(ts|js)$/, '')
    registry[modelId] = mod.default
    for (const alias of mod.aliases ?? []) registry[alias] = mod.default
}

class Bridge {
    haDevices = new Map<string, HADevice>()
    constructor(readonly HA: Connection) {
        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => ha.publishConfig())
        })
        HA.on('setProperty', (id: string, prop: string, value: string) => {
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })
    }

    newDevice(thinqdev: AnyDevice) {
        const meta = thinqdev.meta
        const oldDevice = this.haDevices.get(thinqdev.id)
        if (oldDevice) oldDevice.drop()

        let hadevice: HADevice | undefined

        if (thinqdev.platform === 'thinq1') {
            const devclass = t1deviceTypes[meta.modelId]
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        } else if (thinqdev.platform === 'thinq2') {
            const devclass = t2deviceTypes[meta.modelId]
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        }

        if (!hadevice) {
            console.warn(`${thinqdev.platform} device type ${meta.modelId} unknown`)
            return
        }

        this.haDevices.set(thinqdev.id, hadevice)
        thinqdev.on('close', () => this.dropDevice(hadevice))

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start()
    }

    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) === ha) {
            this.haDevices.delete(ha.id)
            ha.drop()
        }
    }
}

export default Bridge
