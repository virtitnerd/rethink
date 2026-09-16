document.addEventListener('DOMContentLoaded', function () {})

let ws
let reconnectTimer

get('device_id').innerText = new URLSearchParams(window.location.search).get('id')
get('device_status').innerText = 'Waiting for rethink connection...'

// The socket lives at /device, a sibling of this page. Appending to the page's own path instead
// asks for /monitordevice, which nothing serves.
function deviceSocketUrl() {
    const url = new URL('device', window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = window.location.search
    return url
}

// As on the panel: first retry near-immediately, back off only if that fails too.
let retryDelay = 250

function connect() {
    clearTimeout(reconnectTimer)
    if (ws) {
        ws.onclose = ws.onopen = ws.onmessage = null
        try {
            ws.close()
        } catch {}
    }
    ws = new WebSocket(deviceSocketUrl())

    ws.onclose = () => {
        reconnectTimer = setTimeout(connect, retryDelay)
        retryDelay = 5000
        get('device_status').innerText = 'Waiting for rethink connection...'
    }

    ws.onopen = () => {
        retryDelay = 250
        get('device_status').innerText = 'offline'
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
            const json = JSON.parse(ev.data)
            if (json.rx) {
                const div = pushMessage('rx', json.rx, json.injected, json.decoded)
                div.onclick = () => {
                    get('send2').value = json.rx
                    M.updateTextFields()
                }
            }

            if (json.tx) {
                const div = pushMessage('tx', json.tx, json.injected, json.decoded)
                div.onclick = () => {
                    get('send1').value = json.tx
                    M.updateTextFields()
                }
            }

            if (json.status) {
                get('device_status').innerText = json.status
                if (json.status === 'online') {
                    get('btn_send1').disabled = false
                    get('btn_send1').onclick = () => {
                        let cmd = get('send1').value
                        if (cmd[0] === '{') cmd = JSON.parse(cmd)

                        ws.send(JSON.stringify({ sendToDevice: cmd }))
                    }

                    get('btn_send2').disabled = false
                    get('btn_send2').onclick = () => {
                        ws.send(JSON.stringify({ sendFromDevice: get('send2').value }))
                    }
                } else {
                    get('btn_send1').disabled = true
                    get('btn_send2').disabled = true
                }
            }

            if (json.meta) {
                get('device_model').innerText = json.meta.modelId
            }
        }
    }
}

// Same as the panel, and for the same reason its readyState check had to go: the restored socket can
// still read as OPEN here and only report its close afterwards.
window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) connect()
})

// decoded is the same shape util/packet-codec.ts's decodePacket() returns (see the /device
// WS handler in management/index.ts, which decodes server-side so this file never needs its
// own copy of the TLV/AABB parsing logic) - undefined for anything that didn't decode
// (unrecognized framing, or a ThinQ1 JSON-style command, which was never hex to begin with).
function renderDecoded(decoded) {
    const box = document.createElement('div')
    box.classList.add('decoded')

    if (decoded.protocol === 'tlv') {
        const crc = document.createElement('span')
        crc.classList.add('decoded-status', decoded.crcOk ? 'ok' : 'bad')
        crc.textContent = decoded.crcOk ? 'CRC ok' : 'CRC bad'
        box.appendChild(crc)

        for (const { t, v } of decoded.tlv) {
            const item = document.createElement('span')
            item.classList.add('decoded-field')
            item.textContent = `t=0x${t.toString(16)} v=0x${v.toString(16)} (${v})`
            box.appendChild(item)
        }
    } else if (decoded.protocol === 'aabb') {
        const status = document.createElement('span')
        status.classList.add('decoded-status', decoded.checksumOk ? 'ok' : 'bad')
        status.textContent = decoded.checksumOk ? 'checksum ok' : 'checksum bad'
        box.appendChild(status)
    }

    return box
}

function pushMessage(direction, payload, injected, decoded) {
    const timestamp = document.createElement('span')
    const messages = get('messages')

    timestamp.innerText = new Date().toLocaleTimeString()
    timestamp.classList.add('timestamp')
    const div = document.createElement('div')
    div.classList.add(direction, 'message')
    if (injected) div.classList.add('injected')

    const hex = document.createElement('div')
    hex.classList.add('message-hex')
    hex.textContent = payload
    div.appendChild(hex)

    if (decoded) div.appendChild(renderDecoded(decoded))

    div.appendChild(timestamp)

    messages.appendChild(div)

    if (get('autoscroll').checked) messages.scrollTop = messages.scrollHeight

    return div
}

function get(id) {
    return document.getElementById(id)
}

connect()
