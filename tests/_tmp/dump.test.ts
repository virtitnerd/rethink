import { test } from 'node:test'
import { readdirSync, writeFileSync } from 'node:fs'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq1Device, MockThinq2Device } from '@/tests/helpers/mocks'

test('dump every config', async () => {
    const out: Record<string, unknown> = {}
    const dir = new URL('../../cloud/devices/', import.meta.url)
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
        const mod = await import(`@/cloud/devices/${file}`)
        if (mod.platform !== 'thinq1' && mod.platform !== 'thinq2') continue
        const modelId = mod.modelId ?? file.replace(/\.ts$/, '')
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection())
        const meta = { modelId, modelName: modelId, deviceType: '201', swVersion: '1.0' }
        const thinq = mod.platform === 'thinq1' ? new MockThinq1Device('d1', meta) : new MockThinq2Device('d1', meta)
        bridge.newDevice(thinq)
        out[file.replace(/\.ts$/, '')] = { platform: mod.platform, config: ha.devices['d1']?.config ?? null }
        thinq.emit('close')
    }
    writeFileSync(process.env.DUMP_OUT!, JSON.stringify(out))
})
