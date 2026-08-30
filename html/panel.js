document.addEventListener('DOMContentLoaded', function () {
    M.Tooltip.init(document.querySelectorAll('.tooltipped'))
    M.Modal.init(document.querySelectorAll('.modal'))
    M.FormSelect.init(document.querySelectorAll('select'))
    M.Autocomplete.init(document.querySelectorAll('.autocomplete'), {
        data: {
            '101 (Refrigerator)': null,
            '201 (Washer)': null,
            '202 (Dryer)': null,
            '204 (Dishwasher)': null,
            '223 (WashTower)': null,
            '301 (Gas Range)': null,
            '302 (Microwave)': null,
            '401 (Air Conditioner)': null,
        },
    })
})

let ws
let reconnectTimer
// role="img" + aria-label give these icons an accessible name of their own - unlike every other
// material-icons use in this file, none of these three sit next to their own visible text (the
// adjacent "Browser <-> Rethink" etc. is a separate sibling text node describing the whole row,
// not this icon specifically).
const STATUS_OK = `<i class="tiny material-icons green-text" role="img" aria-label="Connected">check</i>`
const STATUS_ERROR = `<i class="tiny material-icons red-text" role="img" aria-label="Error">error</i>`
const STATUS_UNKNOWN = `<i class="tiny material-icons red-text" role="img" aria-label="Unknown">question_mark</i>`
let bridge_status = false

get('status_rethink').innerHTML = STATUS_UNKNOWN
get('status_mqtt').innerHTML = STATUS_UNKNOWN
get('status_bridge').innerHTML = STATUS_UNKNOWN
get('status_bridge_text').innerText = 'Unknown'

const devices = {}

const baseUrl = new URL(window.location)
baseUrl.search = ''
baseUrl.hash = ''

class DeviceEntry {
    constructor(id, remoteState, parent) {
        this.id = id
        this.remoteState = remoteState
        this.row = document.createElement('tr')
        this.updateDom()
        parent.appendChild(this.row)
    }

    destroy() {
        this.row.remove()
    }

    update(remoteState) {
        this.remoteState = remoteState
        this.updateDom()
    }

    updateDom() {
        const children = []

        let td
        // The owner's own name for the appliance, which only the bridge can know. Without it four
        // identical ceiling cassettes are four rows of the same model and a different UUID.
        td = document.createElement('td')
        td.className = 'dev-name'
        td.innerText = this.remoteState.name || '—'
        td.title = this.remoteState.name || '' // the cell is cut off on a narrow screen
        children.push(td)

        td = document.createElement('td')
        td.className = 'dev-id'
        td.innerText = this.id
        td.title = this.id
        children.push(td)

        td = document.createElement('td')
        td.className = 'dev-model'
        // Built with DOM APIs rather than string concatenation/innerHTML on purpose:
        // this.remoteState.model is a modelId reported by the device itself, not something to
        // trust as HTML.
        td.appendChild(document.createTextNode(this.remoteState.model))
        if (!this.remoteState.mapped) {
            const badge = document.createElement('a')
            badge.className = 'chip unsupported-badge tooltipped'
            badge.href = 'https://github.com/anszom/rethink/wiki/Adding-support-for-a-new-device'
            badge.target = '_blank'
            badge.rel = 'noopener'
            badge.setAttribute('data-position', 'bottom')
            badge.setAttribute('data-tooltip', 'Not mapped to Home Assistant yet - click to see how to add support')
            badge.textContent = 'unsupported'
            td.appendChild(document.createTextNode(' '))
            td.appendChild(badge)
        }
        children.push(td)

        td = document.createElement('td')
        td.className = 'dev-platform'
        const platformBadge = document.createElement('span')
        platformBadge.className = `chip platform-badge platform-${this.remoteState.platform}`
        platformBadge.textContent = this.remoteState.platform === 'thinq1' ? 'ThinQ1' : 'ThinQ2'
        td.appendChild(platformBadge)
        children.push(td)

        // The width lives in the stylesheet now: on a narrow screen this cell moves out of the
        // column layout entirely, and a fixed width there would push the row wide again.
        td = document.createElement('td')
        td.className = 'dev-bridge'
        td.innerHTML = `
            <div class="switch">
                <label>Off <input type="checkbox"> <span class="lever"></span>On</label>
            </div>
            <div class="hide preloader-wrapper verysmall active">
                <div class="spinner-layer spinner-green-only">
                <div class="circle-clipper left">
                    <div class="circle"></div>
                </div><div class="gap-patch">
                    <div class="circle"></div>
                </div><div class="circle-clipper right">
                    <div class="circle"></div>
                </div>
                </div>
            </div>`
        children.push(td)

        this.bridgeSwitch = td.getElementsByTagName('input')[0]
        this.bridgeDiv = td.getElementsByClassName('switch')[0]
        this.spinner = td.getElementsByClassName('preloader-wrapper')[0]

        const startBridge = async (deviceType) => {
            this.bridgeBusy = true
            this.refreshUI()

            try {
                await fetchWrapper(`bridge/${this.id}/enable`, { deviceType }, { method: 'POST' })
                this.remoteState.bridged = true
            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        const stopBridge = async () => {
            this.bridgeBusy = true
            this.refreshUI()

            try {
                await fetchWrapper(`bridge/${this.id}/disable`, {}, { method: 'POST' })
                this.remoteState.bridged = false
            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        this.bridgeSwitch.onchange = () => {
            if (this.bridgeSwitch.checked) {
                if (this.remoteState.deviceType) {
                    startBridge(this.remoteState.deviceType)
                } else {
                    get('btn_devicetype_continue').onclick = () => {
                        let devType = get('devtype-input').value
                        devType = devType.split(' ')[0]
                        startBridge(devType)
                        M.Modal.getInstance(get('devicetype_query')).close()
                    }
                    M.Modal.getInstance(get('devicetype_query')).open()
                }
            } else {
                stopBridge()
            }
        }

        td = document.createElement('td')
        td.className = 'dev-actions'

        // Materialize disables a button with pointer-events: none, which would swallow the hover
        // that opens its tooltip - so the tooltip lives on a wrapper instead of on the button.
        // Built with DOM APIs (and encodeURIComponent for the id in the href) rather than a
        // template string on purpose: this.id ultimately comes from device/cloud-reported data,
        // not something to trust unescaped in HTML or a URL.
        const monitorWrap = document.createElement('span')
        monitorWrap.className = 'tooltipped'
        monitorWrap.style.display = 'inline-block'
        monitorWrap.setAttribute('data-position', 'bottom')
        monitorWrap.setAttribute('data-tooltip', 'Monitor')
        const monitorLink = document.createElement('a')
        monitorLink.className = 'btn waves-effect waves-light'
        monitorLink.href = `monitor?id=${encodeURIComponent(this.id)}`
        monitorLink.setAttribute('aria-label', `Open packet monitor for ${this.remoteState.model}`)
        const monitorIcon = document.createElement('i')
        monitorIcon.className = 'material-icons'
        monitorIcon.setAttribute('aria-hidden', 'true')
        monitorIcon.textContent = 'troubleshoot'
        monitorLink.appendChild(monitorIcon)
        monitorWrap.appendChild(monitorLink)
        td.appendChild(monitorWrap)

        const modelJsonWrap = document.createElement('span')
        modelJsonWrap.className = 'tooltipped'
        modelJsonWrap.style.display = 'inline-block'
        modelJsonWrap.setAttribute('data-position', 'bottom')
        modelJsonWrap.setAttribute('data-tooltip', 'Download the modelJSON file. Requires bridge mode.')
        this.modelJsonButton = document.createElement('a')
        this.modelJsonButton.className = 'btn waves-effect waves-light'
        this.modelJsonButton.setAttribute('aria-label', `Download modelJSON for ${this.remoteState.model}`)
        const modelJsonIcon = document.createElement('i')
        modelJsonIcon.className = 'material-icons'
        modelJsonIcon.setAttribute('aria-hidden', 'true')
        modelJsonIcon.textContent = 'description'
        this.modelJsonButton.appendChild(modelJsonIcon)
        modelJsonWrap.appendChild(this.modelJsonButton)
        td.appendChild(modelJsonWrap)

        children.push(td)

        this.modelJsonButton.onclick = () => this.downloadModelJson()

        this.row.replaceChildren(...children)
        Array.from(this.row.getElementsByClassName('tooltipped')).forEach((e) => M.Tooltip.init(e))

        // The markup above is rebuilt from scratch, so the switch comes back unchecked and the
        // spinner comes back visible. Nothing else re-applies the row's actual state: a plain
        // {devices} broadcast - which is what enabling a bridge, or any appliance connecting or
        // dropping, sends - never reaches the branch that refreshes every row. Without this the
        // whole table reads as "all bridges off" until the page is reloaded.
        this.refreshUI()
    }

    refreshUI() {
        if (this.bridgeBusy) {
            this.bridgeDiv.classList.add('hide')
            this.spinner.classList.remove('hide')
        } else {
            this.spinner.classList.add('hide')
            this.bridgeDiv.classList.remove('hide')
            this.bridgeSwitch.checked = !!this.remoteState.bridged
        }

        // Materialize greys out a switch from the disabled attribute, not from a class, so setting
        // a class left the switch live while logged out - clicking it just produced an HTTP 400.
        this.bridgeSwitch.disabled = !bridge_status

        // the modelJSON only comes from the ThinQ cloud, and only for a device registered there
        this.modelJsonButton.classList.toggle('disabled', !(bridge_status && this.remoteState.bridged))
    }

    // The modelJSON is fetched by rethink and handed over as a blob, so that a failure shows up as a
    // toast instead of navigating the panel away to an error page.
    async downloadModelJson() {
        if (this.modelJsonButton.classList.contains('disabled') || this.modelJsonBusy) return

        this.modelJsonBusy = true
        try {
            const response = await fetch(`${baseUrl}bridge/${this.id}/modeljson`)
            if (response.status >= 300) {
                M.toast({ html: `HTTP error ${response.status}: ${await response.text()}` })
                return
            }

            const match = /filename="([^"]*)"/.exec(response.headers.get('content-disposition') ?? '')
            const url = URL.createObjectURL(await response.blob())
            const link = document.createElement('a')
            link.href = url
            link.download = match ? match[1] : `${this.id}.json`
            link.click()
            URL.revokeObjectURL(url)
        } catch (err) {
            M.toast({ html: `FETCH error: ${err}` })
        } finally {
            this.modelJsonBusy = false
        }
    }
}

function refreshDevicesHeader() {
    const count = Object.keys(devices).length
    get('devices_count').textContent = count > 0 ? ` (${count})` : ''
    get('devices_empty').classList.toggle('hide', count > 0)
}

// The first reconnect is near-immediate and only then does it back off. A socket that closes because
// the page went into the back/forward cache, or because rethink restarted under it, otherwise leaves
// the panel blank - everything is behind .hide-when-offline - for the whole retry interval.
let retryDelay = 250

function connect() {
    clearTimeout(reconnectTimer)
    if (ws) {
        // detach first: a socket replaced mid-flight still fires its close, which would queue a second
        // reconnect on top of this one
        ws.onclose = ws.onopen = ws.onmessage = null
        try {
            ws.close()
        } catch {}
    }
    ws = new WebSocket(baseUrl + 'ws')

    ws.onclose = () => {
        get('status_rethink').innerHTML = STATUS_ERROR
        get('status_mqtt').innerHTML = STATUS_UNKNOWN
        document.getElementsByTagName('body')[0].classList.add('offline')
        reconnectTimer = setTimeout(connect, retryDelay)
        retryDelay = 5000
    }

    ws.onopen = () => {
        retryDelay = 250
        get('status_rethink').innerHTML = STATUS_OK
        document.getElementsByTagName('body')[0].classList.remove('offline')
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
            const json = JSON.parse(ev.data)
            if (typeof json.ha === 'boolean') {
                get('status_mqtt').innerHTML = json.ha ? STATUS_OK : STATUS_ERROR
            }

            if (typeof json.devices === 'object') {
                let deletedDevices = Object.keys(devices).filter((id) => !json.devices[id])
                deletedDevices.forEach((id) => {
                    devices[id].destroy()
                    delete devices[id]
                })

                for (const id in json.devices) {
                    const j = json.devices[id]

                    if (!devices[id]) devices[id] = new DeviceEntry(id, j, get('devices_body'))
                    else devices[id].update(j)
                }

                // Only the bridge knows the names, and only when a ThinQ account is linked. Decided
                // over the whole list rather than per row: the column either says something about
                // these appliances or it says nothing about any of them.
                const named = Object.values(devices).some((dev) => dev.remoteState.name)
                get('devices_table').classList.toggle('no-names', !named)

                refreshDevicesHeader()
            }

            if (typeof json.bridge === 'object') {
                bridge_status = json.bridge.loggedIn
                if (json.bridge.loggedIn === true) {
                    document.getElementById('btn_thinq_login').classList.add('hide')
                    document.getElementById('btn_thinq_logout').classList.remove('hide')

                    get('status_bridge').innerHTML = STATUS_OK
                    get('status_bridge_text').innerText = 'Ok'
                } else {
                    document.getElementById('btn_thinq_login').classList.remove('hide')
                    document.getElementById('btn_thinq_logout').classList.add('hide')

                    get('status_bridge').innerHTML = STATUS_ERROR
                    get('status_bridge_text').innerText = 'Not configured'
                }

                for (const id in devices) devices[id].refreshUI()
            }

            if (typeof json.status === 'string') {
                M.toast({ html: json.status })
            }
        }
    }
}

get('btn_thinq_login_continue').onclick = () => {
    if (!get('country_code').validity.valid) return

    const countryCode = get('country_code').value.toUpperCase()

    window.open(`${baseUrl}thinq_login?countryCode=${countryCode}`, '_blank')
}

get('btn_thinq_login_complete').onclick = async () => {
    if (!get('country_code').validity.valid) return

    if (!get('login_url').validity.valid) return

    const countryCode = get('country_code').value.toUpperCase()
    const url = get('login_url').value
    await fetchWrapper(`thinq_login_accept`, { url, countryCode }, { method: 'POST' })
    M.Modal.getInstance(get('thinq_login')).close()
}

get('btn_thinq_logout_continue').onclick = async () => {
    await fetchWrapper(`thinq_logout`, {}, { method: 'POST' })
    M.Modal.getInstance(get('thinq_logout')).close()
}

/*
 * A page restored from the browser's back/forward cache comes back with a socket the browser has
 * killed on the way in, and the close handler hides everything behind .hide-when-offline - so
 * pressing Back from the monitor lands on a panel with no device list. Reconnect unconditionally:
 * the socket can still read as OPEN at this point and only report its close a moment later, so
 * checking readyState here is exactly the mistake that made the first attempt at this a no-op.
 */
window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) connect() // a full load runs connect() on its own
})

// Activity log: opt-in - the /logs WS (see management/index.ts) only connects while this panel
// is expanded, and disconnects the moment it's collapsed, since an actively-bridged device can
// log several lines a second and most sessions aren't watching for it.
const ACTIVITY_MAX_ENTRIES = 300
let activityWs
let activityOpen = false
let activityReconnectTimer
let activityRetryDelay = 250

function activityConnect() {
    clearTimeout(activityReconnectTimer)
    if (activityWs) {
        activityWs.onclose = activityWs.onopen = activityWs.onmessage = null
        try {
            activityWs.close()
        } catch {}
    }

    const topics = get('activity_topics').value.trim()
    const url = baseUrl + 'logs' + (topics ? '?topics=' + encodeURIComponent(topics) : '')
    activityWs = new WebSocket(url)

    activityWs.onopen = () => {
        activityRetryDelay = 250
    }

    activityWs.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        const json = JSON.parse(ev.data)
        appendActivityEntry(json.ts, json.topic, json.text)
    }

    activityWs.onclose = () => {
        if (!activityOpen) return
        activityReconnectTimer = setTimeout(activityConnect, activityRetryDelay)
        activityRetryDelay = Math.min(activityRetryDelay * 2, 5000)
    }
}

function activityDisconnect() {
    clearTimeout(activityReconnectTimer)
    if (activityWs) {
        activityWs.onclose = activityWs.onopen = activityWs.onmessage = null
        try {
            activityWs.close()
        } catch {}
        activityWs = undefined
    }
}

function appendActivityEntry(ts, topic, text) {
    const log = get('activity_log')
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4

    const entry = document.createElement('div')
    entry.className = 'activity-entry'

    const time = document.createElement('span')
    time.className = 'activity-time'
    time.textContent = new Date(ts).toLocaleTimeString()
    entry.appendChild(time)

    const topicChip = document.createElement('span')
    topicChip.className = 'activity-topic'
    topicChip.textContent = topic
    entry.appendChild(topicChip)

    const textSpan = document.createElement('span')
    textSpan.className = 'activity-text'
    textSpan.textContent = text
    entry.appendChild(textSpan)

    log.appendChild(entry)
    while (log.children.length > ACTIVITY_MAX_ENTRIES) log.removeChild(log.firstChild)
    if (atBottom) log.scrollTop = log.scrollHeight
}

function setActivityToggleLabel() {
    const btn = get('btn_toggle_activity')
    btn.replaceChildren()
    const icon = document.createElement('i')
    icon.className = 'material-icons left'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = activityOpen ? 'expand_less' : 'expand_more'
    btn.appendChild(icon)
    btn.appendChild(document.createTextNode(activityOpen ? 'Hide' : 'Show'))
}

get('btn_toggle_activity').onclick = () => {
    activityOpen = !activityOpen
    get('activity_panel').classList.toggle('hide', !activityOpen)
    setActivityToggleLabel()
    if (activityOpen) activityConnect()
    else activityDisconnect()
}

get('activity_topics').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !activityOpen) return
    ev.preventDefault()
    get('activity_log').replaceChildren()
    activityConnect()
})

setActivityToggleLabel()

function get(id) {
    return document.getElementById(id)
}

async function fetchWrapper(path, body, options) {
    if (options.method !== 'GET') {
        if (!options.headers) options.headers = {}
        options.headers['Content-type'] = 'application/json'
    }
    options.body = JSON.stringify(body)
    try {
        const response = await fetch(`${baseUrl}${path}`, options)
        if (response.status >= 300) M.toast({ html: `HTTP error ${response.status}: ${await response.text()}` })

        return response
    } catch (err) {
        M.toast({ html: `FETCH error: ${err}` })
    }
}
connect()
