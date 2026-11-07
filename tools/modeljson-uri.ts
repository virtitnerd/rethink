// Prints the SHAPE of the modelJSON download link LG returns for each device on the account,
// with query values and long opaque path segments masked, so it can be shared safely.
//
//   npx tsx tools/modeljson-uri.ts [path/to/oauth.json]
//
// Uses the same oauth.json login as tools/thinq-control.ts.

import { Client, apiFetch } from '@/bridge/thinqApi'
import { loadState } from '@/util/lgcloud/state'

console.log = console.error

function mask(uri: string) {
    const u = new URL(uri)
    const path = u.pathname
        .split('/')
        .map((seg) => (/^[0-9a-f]{16,}$/i.test(seg) || seg.length > 40 ? `<${seg.length} chars>` : seg))
        .join('/')
    const query = [...u.searchParams.keys()].map((k) => `${k}=<${u.searchParams.get(k)!.length} chars>`).join('&')
    return { scheme: u.protocol, host: u.host, path, query }
}

async function main() {
    const state = loadState(process.argv[2])
    if (!state) throw new Error('not logged in: no usable oauth.json (run tools/lgcloud-monitor.ts once)')
    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    const { thinq2Uri } = await client.gateway
    const devices = (await client.listDevices()) as unknown as { deviceId: string; modelName?: string }[]
    const out = []
    for (const d of devices) {
        if (!d.modelName) continue
        const url = new URL(`${thinq2Uri}/service/application/modeljson`)
        url.searchParams.set('deviceId', d.deviceId)
        url.searchParams.set('modelName', d.modelName)
        try {
            const r = await apiFetch<{ modelJsonUri?: string; modelJsonVer?: string }>(url.toString(), {
                headers: client.headers,
            })
            out.push({
                modelName: d.modelName,
                ver: r.modelJsonVer,
                uri: r.modelJsonUri ? mask(r.modelJsonUri) : null,
                keys: Object.keys(r),
            })
        } catch (err) {
            out.push({ modelName: d.modelName, error: `${err}`.slice(0, 120) })
        }
    }
    process.stdout.write(JSON.stringify(out, null, 1) + '\n')
}

main().catch((err) => {
    console.error(`${err}`)
    process.exit(1)
})
