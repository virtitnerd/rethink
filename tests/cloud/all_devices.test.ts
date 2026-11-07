import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq1Device, MockThinq2Device } from '@/tests/helpers/mocks'

// Every handler in cloud/devices that exports `platform`, under every model id it answers to.
const devicesDir = new URL('../../cloud/devices/', import.meta.url)
const entries: { file: string; platform: 'thinq1' | 'thinq2'; modelId: string }[] = []
const owners = new Map<string, string>()
const collisions: string[] = []
for (const file of readdirSync(devicesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    const mod = await import(`@/cloud/devices/${file}`)
    if (mod.platform !== 'thinq1' && mod.platform !== 'thinq2') continue
    const base = file.replace(/\.ts$/, '')
    for (const modelId of mod.models ? Object.keys(mod.models) : [mod.modelId ?? base, ...(mod.aliases ?? [])]) {
        const key = `${mod.platform}:${modelId}`
        if (owners.has(key)) collisions.push(`${key} (${owners.get(key)} and ${file})`)
        owners.set(key, file)
        entries.push({ file, platform: mod.platform, modelId })
    }
}

const DEVICE_ID = 'e233d130-1eb2-149b-a185-44cb8bcef11f'

function connect(platform: 'thinq1' | 'thinq2', modelId: string) {
    const ha = new MockHAConnection()
    const bridge = new Bridge(ha.asConnection())
    const meta = { modelId, modelName: modelId, deviceType: '201', swVersion: '1.0' }
    const thinq =
        platform === 'thinq1' ? new MockThinq1Device(DEVICE_ID, meta) : new MockThinq2Device(DEVICE_ID, meta)
    bridge.newDevice(thinq)
    return { ha, bridge, thinq }
}

// Deterministic pseudo-random frames, including AABB-shaped ones with plausible lengths.
function frames(): Buffer[] {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const out: Buffer[] = [Buffer.alloc(0), Buffer.from([0xaa]), Buffer.from([0xaa, 0x02, 0xbb]), Buffer.alloc(64, 0xff)]
    for (let i = 0; i < 24; i++) {
        const len = Math.floor(rnd() * 90)
        const b = Buffer.alloc(len)
        for (let j = 0; j < len; j++) b[j] = Math.floor(rnd() * 256)
        if (i % 2 === 0 && len > 4) {
            b[0] = 0xaa
            b[1] = len - 2
            b[len - 1] = 0xbb
        }
        out.push(b)
    }
    return out
}

describe('registry', () => {
    test('no model id is claimed by two handlers on the same platform', () => {
        assert.deepEqual(collisions, [])
    })
})

describe('every registered handler', () => {
    for (const { file, platform, modelId } of entries) {
        describe(`${platform} ${modelId} (${file})`, () => {
            test('is constructed by the bridge and publishes a valid discovery config', (t) => {
                const { ha, thinq } = connect(platform, modelId)
                t.after(() => thinq.emit('close'))
                const dev = ha.devices[DEVICE_ID]
                // Some handlers (TLV) publish their config only after a capabilities response.
                if (!dev?.config) return t.diagnostic('no config at construction')
                const config = dev.config as { components?: Record<string, Record<string, unknown>> }
                assert.ok(config.components, 'a discovery config with components was published')
                const ids = new Set<string>()
                for (const [name, c] of Object.entries(config.components)) {
                    if (c.unique_id === undefined && Object.keys(c).length <= 1) continue // tombstone of a removed entity
                    const uid = String(c.unique_id ?? '')
                    assert.ok(uid.includes('$deviceid'), `${name}: unique_id "${uid}" is scoped to the device`)
                    assert.ok(!ids.has(uid), `${name}: duplicate unique_id ${uid}`)
                    ids.add(uid)
                    for (const k of ['state_topic', 'command_topic'] as const)
                        if (c[k] !== undefined)
                            assert.match(String(c[k]), /^\$this\//, `${name}: ${k} "${String(c[k])}" is under $this/`)
                    if (c.device_class === 'enum')
                        assert.ok(Array.isArray(c.options) && c.options.length > 0, `${name}: enum without options`)
                }
            })

            test('survives malformed and truncated frames', (t) => {
                const { thinq } = connect(platform, modelId)
                t.after(() => thinq.emit('close'))
                const thrown: string[] = []
                for (const f of frames()) {
                    try {
                        ;(thinq as unknown as { inject(b: Buffer): void }).inject(f)
                    } catch (e) {
                        thrown.push(`${f.toString('hex').slice(0, 24)}: ${(e as Error).message.slice(0, 60)}`)
                    }
                }
                assert.deepEqual(thrown.slice(0, 3), [], `${thrown.length} frame(s) made the handler throw`)
            })

            test('can be closed and dropped without throwing', () => {
                const { thinq } = connect(platform, modelId)
                thinq.emit('close')
            })
        })
    }
})
