import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3L2CNV4W_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3L2CNV4W_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.8' }

// Synthetic frames built from the confirmed field layout (LG's own modelJson for this
// model — see the class header comment), not from a real capture yet. Byte offsets and
// enum values match modelJson.Monitoring.protocol / modelJson.Value exactly; the frames
// themselves are hand-assembled to exercise that mapping. Replace/extend with real
// tools/rethink-capture.ts samples once available.

// All-zero: power off, idle.
const SAMPLE_STATE_OFF = buf(`
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
`)

// Running, Normal course (id 5): Soil=Normal, Spin=Extra High, Temp=Warm, one extra
// rinse, Steam + TurboWash on, FreshCare + RemoteStart armed, PreState=Initial,
// remaining/initial time 1h05/1h10, 12 cycles since last tub clean.
const SAMPLE_STATE_RUNNING_NORMAL = buf(`
    17 01 05 01 0a 05 00 03 05 04 10 00 00 00 84 81 00 00 00 05 00 0c 06 00
`)

// Door-open error (DE1, id 17) interrupting a cycle set to the Normal course.
const SAMPLE_STATE_ERROR_DE1 = buf(`
    07 00 00 00 00 05 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
`)

// Real capture (2026-08-22), not synthetic: the courseInfo mirror bundled inside a
// mid-cycle WasherMonitoring diagmon report, decoded from its base64 <data> field.
// State=Detecting, Normal course, RemoteStart armed, tub-clean count 48. Option3=2 here —
// a real, undocumented bit pattern (not InitialBit/0x20), useful for confirming option3_raw
// surfaces it as-is rather than only recognizing the one named bit.
const SAMPLE_STATE_REAL_MIDCYCLE_COURSEINFO = buf(`
    14 01 11 01 11 05 00 03 05 04 02 00 00 00 00 80 02 00 00 05 6a 30 00 00
`)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'pause',
            'course_selection',
            'remote_start_button',
            'status',
            'pre_state',
            'error',
            'error_message',
            'course',
            'op_course',
            'smart_course',
            'soil',
            'spin',
            'temp',
            'dry_level',
            'rinse_count',
            'extra_rinse_count',
            'child_lock',
            'steam',
            'prewash',
            'turbowash',
            'extra_rinse',
            'coldwash',
            'fresh_care',
            'remote_start',
            'initial_bit',
            'option3_raw',
            'tub_clean_count',
            'load_level',
            'reserve_time',
            'initial_time',
            'remaining_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok(Array.isArray(components.status.options))
        assert.ok((components.status.options as string[]).includes('Running'))
        assert.ok((components.status.options as string[]).includes('Error auto-off'))

        // 9 physical-dial courses + 16 app-downloadable SmartCourse ones.
        assert.deepEqual(components.course_selection.options, [
            'Tub Clean',
            'Bright Whites',
            'Bedding',
            'Heavy Duty',
            'Normal',
            'Perm Press',
            'Delicates',
            'Towels',
            'Speed Wash',
            'Small Load',
            'Color Care',
            'Beachwear',
            'New Clothes',
            'Denim',
            'Swimwear',
            'Rainy Day',
            'Gym Clothes',
            'Sweat Stains',
            'Single Garments',
            'Baby Clothes',
            'Overnight Wash',
            'Econo Wash',
            'Delicate Dresses',
            'Half Load Wash',
            'Full Load Wash',
        ])
    })

    test('course_selection defaults to Normal on construction, before any data arrives', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID].properties.course_selection, 'Normal')
    })

    test('course_selection stays at its default while idle (APCourse=0 is not a real course)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_OFF) // APCourse byte is 0
        assert.equal(ha.devices[DEVICE_ID].properties.course_selection, 'Normal')
    })

    test('controls_available defaults to offline on construction, before any data arrives', () => {
        // Regression test: this was previously only ever published reactively inside the
        // data handler, so a process that hadn't yet seen a fresh frame (e.g. right after a
        // restart, before the washer reconnects) left HA showing a stale value retained from
        // whatever a PREVIOUS process last published - stuck indefinitely if that was
        // "offline" (e.g. the washer was mid-cycle when that earlier process stopped).
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID].properties.controls_available, 'offline')
    })

    test('course_selection/remote_start_button availability tracks Off/Initial vs a running cycle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_OFF) // State=Off
        assert.equal(ha.devices[DEVICE_ID].properties.controls_available, 'online')

        thinq.emit('data', SAMPLE_STATE_RUNNING_NORMAL) // State=Running
        assert.equal(ha.devices[DEVICE_ID].properties.controls_available, 'offline')

        thinq.emit('data', SAMPLE_STATE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.controls_available, 'online')
    })

    test('OFF state publishes power=OFF and idle defaults', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.soil, '-')
        assert.equal(props.spin, '-')
        assert.equal(props.temp, '-')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.tub_clean_count, 0)
    })

    test('Running Normal course decodes course/soil/spin/temp/options/time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_RUNNING_NORMAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Running')
        assert.equal(props.pre_state, 'Initial')
        assert.equal(props.course, 'Normal')
        assert.equal(props.soil, 'Normal')
        assert.equal(props.spin, 'Extra high')
        assert.equal(props.temp, 'Warm')
        assert.equal(props.rinse_count, '0')
        assert.equal(props.extra_rinse_count, '1')
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'ON')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.fresh_care, 'ON')
        assert.equal(props.coldwash, 'OFF')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.tub_clean_count, 12)
        assert.equal(props.initial_time, 70)
        assert.equal(props.remaining_time, 65)
        assert.equal(props.error, 'OFF')
        assert.equal(props.op_course, 'Normal')
        assert.equal(props.smart_course, '0')
        assert.equal(props.initial_bit, 'OFF')
        assert.equal(props.option3_raw, 0)
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.load_level, 0)
    })

    test('real mid-cycle capture decodes cleanly, including an undocumented Option3 bit', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_REAL_MIDCYCLE_COURSEINFO)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Detecting')
        assert.equal(props.course, 'Normal')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.tub_clean_count, 48)
        assert.equal(props.smart_course, 'Econo Wash')
        // Option3=2 here (bit 1) — not InitialBit (bit 5, 0x20) — so the named sensor stays
        // off, but the raw byte still surfaces the undocumented bit for future investigation.
        assert.equal(props.initial_bit, 'OFF')
        assert.equal(props.option3_raw, 2)
    })

    test('Door-open error publishes error binary + descriptive message', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_ERROR_DE1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Error auto-off')
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door open error (DE1)')
        assert.equal(props.course, 'Normal')
    })

    test('Frames shorter than the 24-byte layout are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AABBCC'))
        // course_selection and controls_available are both published at construction time,
        // independent of any frame; nothing else should appear from a too-short frame.
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            course_selection: 'Normal',
            controls_available: 'offline',
        })
    })

    test('HA write power=OFF sends the modelJson PowerOff envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' }])
    })

    test('HA write power=ON sends nothing (no PowerOn action in the modelJson)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.deepEqual(thinq.sent, [])
    })

    test('HA write pause sends the modelJson OperationStop envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' }])
    })

    test('start() sends a Mon/Start subscription on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
    })

    test('remote_start_button sends OperationStart with the default (Normal) course', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('remote_start_button', '')
        assert.equal(thinq.sent.length, 1)
        const sent = thinq.sent[0] as { Cmd: string; CmdOpt: string; Value: string; Format: string; Data: string }
        assert.equal(sent.Cmd, 'Control')
        assert.equal(sent.CmdOpt, 'Operation')
        assert.equal(sent.Value, 'Start')
        assert.equal(sent.Format, 'B64')
        // Matches a real captured OperationStart command for the Normal course (2026-08-22),
        // Data: "BQMFBAAAAAAAIAYAAAAAAAAAAAAA" — byte-for-byte, not just the modelJson-derived guess.
        assert.deepEqual(
            [...Buffer.from(sent.Data, 'base64')],
            [5, 3, 5, 4, 0, 0, 0, 0, 0, 0x20, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        )
    })

    test('selecting a SmartCourse and starting sends APCourse=10 with the real SmartCourse id', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('course_selection', 'Small Load')
        assert.equal(ha.devices[DEVICE_ID].properties.course_selection, 'Small Load')

        thinq.resetRecorder()
        dev.setProperty('remote_start_button', '')
        const sent = thinq.sent[0] as { Data: string }
        // Small Load (SmartCourse id 51): Soil=3, SpinSpeed=5, WaterTemp=4, OPCourse=15.
        // APCourse is fixed at 10 (Download Course) and the SmartCourse slot carries 51,
        // instead of APCourse=<dial id> and SmartCourse=0 for a physical-dial course.
        assert.deepEqual(
            [...Buffer.from(sent.Data, 'base64')],
            [10, 3, 5, 4, 0, 0, 0, 0, 0, 0x20, 15, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        )
    })

    test('course_selection tracks the live course until the user picks one', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_RUNNING_NORMAL) // course id 5 -> Normal
        assert.equal(ha.devices[DEVICE_ID].properties.course_selection, 'Normal')

        dev.setProperty('course_selection', 'Heavy Duty')
        assert.equal(ha.devices[DEVICE_ID].properties.course_selection, 'Heavy Duty')

        // a later frame still reporting the Normal course shouldn't override the user's pick
        thinq.emit('data', SAMPLE_STATE_RUNNING_NORMAL)
        assert.equal(ha.devices[DEVICE_ID].properties.course_selection, 'Heavy Duty')

        thinq.resetRecorder()
        dev.setProperty('remote_start_button', '')
        const sent = thinq.sent[0] as { Data: string }
        // Heavy Duty (id 4): Soil=5, SpinSpeed=5, WaterTemp=4, OPCourse=7
        assert.deepEqual(
            [...Buffer.from(sent.Data, 'base64')],
            [4, 5, 5, 4, 0, 0, 0, 0, 0, 0x20, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        )
    })

    test('diagmon energyMonInfo publishes last-cycle energy/course/completion time', () => {
        const { ha, thinq } = makeDevice()
        // Real captured report (2026-08-22, Normal course completing): diagMonType
        // "WasherMonitoring", diagMonData base64-decodes to
        // <lgedmRoot><energyMonInfo><event>2</event><course>5</course><power>154</power>
        // <option>...</option><dlCourse>106</dlCourse>
        // <useDate>20260822 23:48:24</useDate></energyMonInfo></lgedmRoot>
        thinq.emit('diagmon', 'WasherMonitoring', {
            lgedmRoot: {
                energyMonInfo: {
                    event: 2,
                    course: 5,
                    power: 154,
                    option: 'FAERAREFAAMFBAIAAAAAgAIAAAVqMAAA',
                    dlCourse: 106,
                    useDate: '20260822 23:48:24',
                },
            },
        })
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.last_cycle_energy, 154)
        assert.equal(props.last_cycle_course, 'Normal')
        assert.equal(props.last_cycle_completed, '20260822 23:48:24')
    })

    test('diagmon tubInfo/courseInfo are ignored (not energyMonInfo)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('diagmon', 'WasherMonitoring', {
            lgedmRoot: { tubInfo: { event: 2, count: 49, maxCount: 30 } },
        })
        assert.equal(ha.devices[DEVICE_ID].properties.last_cycle_energy, undefined)
    })

    // OperationStart's encoding is cross-confirmed against a real captured command from this
    // device (see the class header comment and the test above) as well as
    // ha-smartthinq-sensors' independent ThinQ1 command builder.
})
