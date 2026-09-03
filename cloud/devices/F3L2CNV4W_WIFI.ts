import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'

// LG F3L2CNV4W_WIFI front-load washer (ThinQ1, deviceType 201).
//
// Field layout and enums below come directly from LG's own modelJson for this model
// (fetched via the wideq library against a real account, not reverse-engineered from
// captures) — see cloud/thinq1/http.ts for how a device's modelId is matched to this
// class. The 24-byte Monitoring.protocol block maps 1:1 to the buffer `thinq.on('data')`
// delivers here (each field is exactly one byte, at the startByte given below).
//
// PowerOff, pause/stop, and starting a cycle (OperationStart) are all implemented — their
// wire shape ({Cmd:'Control', CmdOpt:..., Value:...}) matches WTDN3.ts's already-verified
// pattern, cross-confirmed by the modelJson's ControlWifi.action entries.
// OperationStart's course-parameter array encoding (courseId/Soil/SpinSpeed/WaterTemp/../
// OPCourse as one byte each, base64) is confirmed against a real captured command from this
// device (see the test file), and independently cross-checked against
// ha-smartthinq-sensors' ThinQ1 v1 command builder, which already drives this exact model.
// Remote power-ON is NOT implemented: the modelJson defines no PowerOn action at all for
// this model (the physical dial is presumably the only way to arm remote start).
//
// Per-cycle energy usage (last_cycle_energy/course/completed) comes from a second channel
// entirely: HTTP diagmon reports (cloud/thinq1/http.ts), not the persistent :47878 status
// socket this class otherwise reads from. See the thinq.on('diagmon', ...) handler below.
//
// course_selection only offers the 9 physical-dial AP courses, not the 16 SmartCourse ones:
// starting one via OperationStart applies the requested Soil/SpinSpeed/WaterTemp, but the
// machine keeps reporting SmartCourse/OPCourse identity for whatever's actually resident
// (a downloaded course), not the id requested - OperationStart's SmartCourse field isn't a
// live selector, the machine only ever runs whatever's been downloaded onto it. smart_course
// is a select instead: it shows the actually-resident course and triggers a real download
// (see synthesizeSmartCourseDownload below and cloud/thinq1/http.ts's
// WasherCourseDownloadSvc) the moment a different one is picked.

const STATES: Record<number, string> = {
    0: 'Off',
    5: 'Initial',
    6: 'Paused',
    7: 'Error auto-off',
    10: 'Reserved',
    20: 'Detecting',
    21: 'Add drain',
    22: 'Load display',
    23: 'Running',
    30: 'Rinsing',
    31: 'Rinse hold',
    40: 'Spinning',
    50: 'Drying',
    60: 'End',
    61: 'Fresh care',
    79: 'Smart diagnosis',
    81: 'Tub clean count alarm',
    101: 'Smart diagnosis data',
}

const ERRORS: Record<number, string> = {
    0: 'OK',
    1: 'Door lock error (DE2)',
    2: 'No fill error (IE)',
    3: 'Not draining error (OE)',
    4: 'Out of balance error (UE)',
    5: 'Overfill error (FE)',
    6: 'Water sensor error (PE)',
    7: 'Thermistor error (tE)',
    8: 'Locked motor error (LE)',
    9: 'CE error',
    10: 'dHE error',
    11: 'Power failure error (PF)',
    12: 'Freeze error (FF)',
    13: 'dCE error',
    14: 'AE error',
    15: 'EEPROM error (EE)',
    16: 'Suds error (Sud)',
    17: 'Door open error (DE1)',
    18: 'Sliding lid open error (LOE)',
    19: 'PS error',
}

const SOIL: Record<number, string> = {
    0: '-',
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

const SPIN: Record<number, string> = {
    0: '-',
    1: 'No spin',
    2: 'Low',
    3: 'Medium',
    4: 'High',
    5: 'Extra high',
}

const TEMP: Record<number, string> = {
    0: '-',
    1: 'Tap cold',
    2: 'Cold',
    3: 'Semi warm',
    4: 'Warm',
    5: 'Warm',
    6: 'Hot',
    7: 'Extra hot',
}

const DRY_LEVEL: Record<number, string> = {
    0: '-',
    5: 'Turbo',
    6: 'Wind',
    7: '30 min',
    8: '60 min',
    9: '90 min',
    10: '120 min',
    11: '150 min',
}

const RINSE_COUNT: Record<number, string> = {
    0: '0',
    1: '1',
    2: '2',
    3: '3',
}

// Physical-dial ("AP") courses; ids beyond this table (smart/downloaded courses) fall
// back to their raw numeric id.
const AP_COURSE: Record<number, string> = {
    1: 'Tub Clean',
    2: 'Bright Whites',
    3: 'Bedding',
    4: 'Heavy Duty',
    5: 'Normal',
    6: 'Perm Press',
    7: 'Delicates',
    8: 'Towels',
    9: 'Speed Wash',
    10: 'Download Course',
    11: 'Spin Only',
}

// Remote-start defaults per course, straight from modelJson's APCourse[id].function[]
// (Soil/WaterTemp/SpinSpeed) and APCourse[id].OPCourse. id 11 (Spin Only, hidden —
// "visibility":"gone" in the modelJson) is deliberately excluded: not offered by the
// physical dial or the official app either. id 10 (Download Course) is also excluded - it's
// not a fixed course, it's "whatever SmartCourse is actually resident on the machine", and we
// have no way to control that (see the header comment).
const COURSE_DEFAULTS: Record<number, { soil: number; spinSpeed: number; waterTemp: number; opCourse: number }> = {
    1: { soil: 0, spinSpeed: 3, waterTemp: 0, opCourse: 13 }, // Tub Clean
    2: { soil: 3, spinSpeed: 5, waterTemp: 6, opCourse: 8 }, // Bright Whites
    3: { soil: 3, spinSpeed: 3, waterTemp: 4, opCourse: 4 }, // Bedding
    4: { soil: 5, spinSpeed: 5, waterTemp: 4, opCourse: 7 }, // Heavy Duty
    5: { soil: 3, spinSpeed: 5, waterTemp: 4, opCourse: 6 }, // Normal
    6: { soil: 3, spinSpeed: 3, waterTemp: 4, opCourse: 5 }, // Perm Press
    7: { soil: 3, spinSpeed: 3, waterTemp: 2, opCourse: 10 }, // Delicates
    8: { soil: 3, spinSpeed: 5, waterTemp: 4, opCourse: 14 }, // Towels
    9: { soil: 1, spinSpeed: 5, waterTemp: 6, opCourse: 12 }, // Speed Wash
}

const DEFAULT_COURSE_ID = 5 // Normal

// OPCourse (byte 22): the machine's internal course code, which AP_COURSE's dial position
// maps onto (Normal -> OPCourse 6, etc. — see COURSE_DEFAULTS). Published separately as a
// diagnostic since it's a richer catalog than AP_COURSE (includes codes no physical dial
// position selects directly, e.g. Small Load, Rugged, Sportswear).
const OP_COURSE: Record<number, string> = {
    0: '-',
    1: 'Refresh',
    2: 'Sanitary',
    3: 'Allergiene',
    4: 'Bedding',
    5: 'Perm Press',
    6: 'Normal',
    7: 'Heavy Duty',
    8: 'Bright Whites',
    9: 'Cold Care',
    10: 'Delicates',
    11: 'Hand Wash',
    12: 'Speed Wash',
    13: 'Tub Clean',
    14: 'Towels',
    15: 'Small Load',
    16: 'Rinse+Spin',
    17: 'Rugged',
    18: 'KidsWears',
    19: 'WorkOut Wear',
    20: 'Drain+Spin',
    21: 'Sportswear',
    22: 'Jumbo Wash',
}

// SmartCourse (byte 20): a course downloaded from the app's "smart course" picker, distinct
// from AP_COURSE's physical-dial courses. modelJson's SmartCourse table has exactly these 16
// entries (not ~90 — corrected after actually counting); ids outside this table (or 0,
// meaning none downloaded) fall back to their raw number. Read-only: this is a label for
// whatever the machine reports as resident, not something course_selection can set (see the
// header comment) — there's no defaults table to pair it with any more.
const SMART_COURSE: Record<number, string> = {
    51: 'Small Load',
    52: 'Color Care',
    53: 'Beachwear',
    54: 'New Clothes',
    55: 'Denim',
    59: 'Swimwear',
    60: 'Rainy Day',
    61: 'Gym Clothes',
    63: 'Sweat Stains',
    64: 'Single Garments',
    100: 'Baby Clothes',
    105: 'Overnight Wash',
    106: 'Econo Wash',
    107: 'Delicate Dresses',
    108: 'Half Load Wash',
    109: 'Full Load Wash',
}

// modelJson ControlWifi.action.OperationStart.data, positionally:
//   [APCourse, Soil, SpinSpeed, WaterTemp, RinseOption, Reserve_Time_H, Reserve_Time_M,
//    Option1, Option2, Option3, OPCourse, SmartCourse, 0,0,0,0,0,0,0,0,0]
// Confirmed against a real captured command (Normal course): courseId, Soil, SpinSpeed,
// WaterTemp, RinseOption, Reserve_Time_H/M, Option1, Option2, OPCourse, SmartCourse and all
// 9 trailing bytes matched this encoding exactly. The one gap the capture caught: Option3
// needs bit 5 (0x20) set — modelJson's "InitialBit" — which a bare 0 does not produce;
// without it the machine never actually started.
const INITIAL_BIT = 0x20 // Option3 bit 5

// initial defaults to true (OperationStart's own use, which must always set InitialBit to
// actually start a cycle) but a real downloaded SmartCourse's own DATA field does NOT have
// it set (confirmed against a real capture: it's just defining the course, not starting
// one) - see synthesizeSmartCourseDownload() below, which passes initial:false.
function encodeCourse(
    apCourse: number,
    smartCourse: number,
    d: { soil: number; spinSpeed: number; waterTemp: number; opCourse: number },
    initial: boolean = true,
): string {
    // prettier-ignore
    const bytes = [
        apCourse, d.soil, d.spinSpeed, d.waterTemp, 0, 0, 0, 0, 0, initial ? INITIAL_BIT : 0, d.opCourse, smartCourse,
        0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
    return Buffer.from(bytes).toString('base64')
}

// courseId is an AP_COURSE dial position (1-9). SmartCourse ids are deliberately not
// resolvable here — see the header comment for why offering them as startable was wrong.
function encodeCourseStart(courseId: number): string | undefined {
    const ap = COURSE_DEFAULTS[courseId]
    if (ap) return encodeCourse(courseId, 0, ap)

    return undefined
}

// Every SmartCourse download uses this fixed APCourse sentinel - confirmed both via live
// status monitoring (the machine always reports APCourse=10 whenever a SmartCourse is
// resident, see the header comment above) and directly in modelJson, where all 16
// SmartCourse entries have APCourse:10.
const SMART_COURSE_AP_COURSE = 10

// Soil/SpinSpeed/WaterTemp/OPCourse for each SmartCourse, straight from modelJson's own
// SmartCourse[id].function array and OPCourse field - not guessed, and independently
// confirmed byte-for-byte against a real downloaded course (id 51/Small Load:
// soil=3/spinSpeed=5/waterTemp=4/opCourse=15). This lets rethink build a real, correct
// CourseDownload payload for any of these 16 entirely locally, with no LG dependency at
// all - see synthesizeSmartCourseDownload() below and cloud/thinq1/http.ts's
// WasherCourseDownloadSvc, which serves it without ever proxying.
const SMART_COURSE_DEFAULTS: Record<number, { soil: number; spinSpeed: number; waterTemp: number; opCourse: number }> =
    {
        51: { soil: 3, spinSpeed: 5, waterTemp: 4, opCourse: 15 }, // Small Load
        52: { soil: 3, spinSpeed: 3, waterTemp: 2, opCourse: 6 }, // Color Care
        53: { soil: 1, spinSpeed: 3, waterTemp: 2, opCourse: 10 }, // Beachwear
        54: { soil: 1, spinSpeed: 2, waterTemp: 2, opCourse: 6 }, // New Clothes
        55: { soil: 3, spinSpeed: 3, waterTemp: 2, opCourse: 6 }, // Denim
        59: { soil: 1, spinSpeed: 2, waterTemp: 2, opCourse: 10 }, // Swimwear
        60: { soil: 3, spinSpeed: 5, waterTemp: 4, opCourse: 6 }, // Rainy Day
        61: { soil: 1, spinSpeed: 3, waterTemp: 4, opCourse: 21 }, // Gym Clothes
        63: { soil: 1, spinSpeed: 5, waterTemp: 4, opCourse: 6 }, // Sweat Stains
        64: { soil: 1, spinSpeed: 5, waterTemp: 6, opCourse: 12 }, // Single Garments
        100: { soil: 3, spinSpeed: 5, waterTemp: 6, opCourse: 6 }, // Baby Clothes
        105: { soil: 3, spinSpeed: 2, waterTemp: 4, opCourse: 6 }, // Overnight Wash
        106: { soil: 3, spinSpeed: 5, waterTemp: 2, opCourse: 6 }, // Econo Wash
        107: { soil: 1, spinSpeed: 2, waterTemp: 2, opCourse: 10 }, // Delicate Dresses
        108: { soil: 3, spinSpeed: 5, waterTemp: 4, opCourse: 6 }, // Half Load Wash
        109: { soil: 5, spinSpeed: 5, waterTemp: 4, opCourse: 6 }, // Full Load Wash
    }

// Builds the exact <COURSE><ID>..</ID><DATA>..</DATA></COURSE> payload real LG's
// courseDownload content endpoint serves for a given SmartCourse id, entirely locally -
// called from cloud/thinq1/http.ts's WasherCourseDownloadSvc instead of proxying to LG
// whenever courseId matches one of ours.
export function synthesizeSmartCourseDownload(courseId: string): { contentType: string; body: Buffer } | undefined {
    const id = Number(courseId)
    const params = SMART_COURSE_DEFAULTS[id]
    if (!Number.isInteger(id) || !params) return undefined

    const data = encodeCourse(SMART_COURSE_AP_COURSE, id, params, false)
    return {
        contentType: 'text/xml;charset=utf-8',
        body: Buffer.from(`<COURSE><ID>${id}</ID><DATA>${data}</DATA></COURSE>`),
    }
}

// The persistent-socket message that tells the device "a course is ready to download" -
// confirmed against a real capture: the app sends this with a real LG-issued work-order
// id, the device echoes it back verbatim as WasherCourseDownloadSvc's selectedCd.
// Sending it ourselves with our own id (just the SmartCourse's numeric id - the device
// doesn't validate the id's format, only relays it) triggers the exact same download flow,
// entirely locally.
function encodeCourseDownloadTrigger(smartCourseId: number): string {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><lgenotify><item><message lang="KO">${smartCourseId}/${smartCourseId}</message></item></lgenotify>`
    return Buffer.from(xml).toString('base64')
}

// Every id that's actually startable, for the course_selection select's option list and its
// name -> id reverse lookup.
const SELECTABLE_COURSE_NAMES: Record<number, string> = Object.fromEntries(
    Object.keys(COURSE_DEFAULTS).map((id) => [id, AP_COURSE[Number(id)]]),
)

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    course_selection: {
                        platform: 'select',
                        unique_id: '$deviceid-course-selection',
                        state_topic: '$this/course_selection',
                        command_topic: '$this/course_selection/set',
                        // Singular availability_topic collides with the device-level `availability`
                        // list (see HADevice.config) in HA's schema - both forms set the same
                        // exclusion group, and HA rejects the whole component if both are present.
                        // The list form doesn't conflict, so use it here too.
                        availability: [{ topic: '$this/controls_available' }],
                        name: 'Course selection',
                        icon: 'mdi:tune-vertical-variant',
                        options: Object.values(SELECTABLE_COURSE_NAMES),
                    },
                    remote_start_button: {
                        platform: 'button',
                        unique_id: '$deviceid-remote-start-button',
                        command_topic: '$this/remote_start_button/set',
                        // Separate from course_selection's controls_available: OperationStart is
                        // also how you resume a paused cycle (modelJson has no distinct Resume
                        // action - Off/Initial/Paused all send the same Start command), so this
                        // button needs to stay available through Paused too. course_selection
                        // does not: we have no evidence for what the machine does if you swap
                        // courses while paused and hit Start, so it stays locked to Off/Initial.
                        availability: [{ topic: '$this/remote_start_available' }],
                        payload_press: '',
                        name: 'Remote Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: Object.values(STATES),
                    },
                    pre_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pre-state',
                        state_topic: '$this/pre_state',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                        device_class: 'enum',
                        options: Object.values(STATES),
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: Object.values(ERRORS),
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    op_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-op-course',
                        state_topic: '$this/op_course',
                        name: 'Internal course code',
                        icon: 'mdi:cog-outline',
                        entity_category: 'diagnostic',
                    },
                    smart_course: {
                        platform: 'select',
                        unique_id: '$deviceid-smart-course',
                        state_topic: '$this/smart_course',
                        command_topic: '$this/smart_course/set',
                        // Same reasoning as course_selection: we have no evidence it's safe to
                        // trigger a new download mid-cycle, so this stays locked to Off/Initial
                        // like everything else that changes what's about to run.
                        availability: [{ topic: '$this/controls_available' }],
                        name: 'SmartCourse',
                        icon: 'mdi:cloud-download-outline',
                        // '-' covers smartCourse=0 (nothing downloaded yet) or any id outside
                        // our 16-entry table, matching this file's convention for unset/unknown
                        // numeric-enum fields (see SOIL/SPIN/TEMP/OP_COURSE).
                        options: ['-', ...Object.values(SMART_COURSE)],
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:water-opacity',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Water temperature',
                        icon: 'mdi:thermometer',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry-level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:tumble-dryer',
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse-count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinse count',
                        icon: 'mdi:water-sync',
                        entity_category: 'diagnostic',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra-rinse-count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-plus-outline',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child-lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                        entity_category: 'diagnostic',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
                        name: 'Prewash',
                        icon: 'mdi:water-outline',
                    },
                    turbowash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        name: 'TurboWash',
                        icon: 'mdi:speedometer',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra-rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-plus-outline',
                    },
                    coldwash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-coldwash',
                        state_topic: '$this/coldwash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh-care',
                        state_topic: '$this/fresh_care',
                        name: 'Fresh care',
                        icon: 'mdi:air-filter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start armed',
                        icon: 'mdi:play-circle-outline',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub-clean-count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Cycles since tub clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    // Diagnostic, not a guess: byte 23 clearly varies with load size but has no
                    // known scale or unit yet, so it's exposed as-is rather than invented.
                    load_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load-level',
                        state_topic: '$this/load_level',
                        name: 'Load level (raw)',
                        icon: 'mdi:scale-bathroom',
                        entity_category: 'diagnostic',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve-time',
                        state_topic: '$this/reserve_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay wash time',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    last_cycle_energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-last-cycle-energy',
                        state_topic: '$this/last_cycle_energy',
                        // Wh: TA2k/ioBroker.lg-thinq's docs document the same field name
                        // ("power") on LG's ThinQ2 statistics API with an explicit "divide by
                        // 1000 for kWh" comment - a different endpoint than our ThinQ1 diagmon
                        // energyMonInfo, but the same LG-ecosystem naming convention, and 154 Wh
                        // is a physically plausible total for a ~77 min Normal cycle. state_class
                        // has to be "total_increasing", not "measurement": HA rejects that pairing
                        // for device_class "energy" outright. It also happens to be the correct
                        // semantics here - HA already treats a drop in a total_increasing value as
                        // a meter reset and starts counting again from there, which is exactly what
                        // a new cycle's total does relative to the last one.
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                        name: 'Last cycle energy usage',
                        icon: 'mdi:lightning-bolt-outline',
                    },
                    last_cycle_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-last-cycle-course',
                        state_topic: '$this/last_cycle_course',
                        name: 'Last completed course',
                        icon: 'mdi:pin-outline',
                        entity_category: 'diagnostic',
                    },
                    last_cycle_completed: {
                        platform: 'sensor',
                        unique_id: '$deviceid-last-cycle-completed',
                        state_topic: '$this/last_cycle_completed',
                        name: 'Last cycle completed at',
                        icon: 'mdi:clock-check-outline',
                        entity_category: 'diagnostic',
                    },
                    initial_bit: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-initial-bit',
                        state_topic: '$this/initial_bit',
                        name: 'Initial bit',
                        icon: 'mdi:flag-outline',
                        entity_category: 'diagnostic',
                    },
                    // Diagnostic, not a guess: only bit 5 (initial_bit above) is confirmed.
                    // The rest of this byte is undecoded, exposed raw so a future capture can
                    // reveal what it does rather than being silently dropped.
                    option3_raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-option3-raw',
                        state_topic: '$this/option3_raw',
                        name: 'Option3 (raw)',
                        icon: 'mdi:code-braces',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )

        // The washer reports APCourse=0 while idle/no course actively dialed — that's not
        // in COURSE_DEFAULTS, so the sync-on-data logic below never fires for it. Publish
        // our own default up front so the select entity doesn't sit at "unknown" forever.
        this.publishProperty('course_selection', SELECTABLE_COURSE_NAMES[this.pendingCourseId])

        // Same class of bug as course_selection above, and it's the one that actually bit us:
        // controls_available was ONLY ever published reactively, inside thinq.on('data', ...)
        // below. If this process's lifetime hasn't seen a fresh frame yet (e.g. the washer
        // hasn't reconnected since a restart), that topic had never been republished, so HA
        // was just showing whatever was last retained from a PREVIOUS process — stuck
        // "offline" indefinitely if that process's last frame happened to be mid-cycle.
        // Publish a real default immediately so a fresh process is never silently stuck on a
        // stale prior-process value; the data handler corrects it the moment a real frame
        // arrives.
        this.publishProperty('controls_available', 'offline')
        this.publishProperty('remote_start_available', 'offline')

        thinq.on('data', (buf) => {
            if (buf.length < 24) return

            const state = buf[0]
            const timeRemain = buf[1] * 60 + buf[2]
            const timeInitial = buf[3] * 60 + buf[4]
            const apCourse = buf[5]
            const error = buf[6]
            const soil = buf[7]
            const spin = buf[8]
            const temp = buf[9]
            const rinseOption = buf[10]
            const dryLevel = buf[11]
            const reserveH = buf[12]
            const reserveM = buf[13]
            const option1 = buf[14]
            const option2 = buf[15]
            const option3 = buf[16]
            const preState = buf[19]
            const smartCourse = buf[20]
            const tclCount = buf[21]
            const opCourse = buf[22]
            const loadLevel = buf[23]

            const rinseCount = rinseOption & 0x0f
            const extraRinseCount = (rinseOption >> 4) & 0x0f

            this.publishProperty('power', state > 0 ? 'ON' : 'OFF')
            this.publishProperty('error_message', ERRORS[error] ?? String(error))
            this.publishProperty('error', error ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[state] ?? String(state))
            // Course selection only makes sense when the machine is actually idle — mid-cycle
            // it'd let you fire an OperationStart with different course params than what's
            // running, which we have no evidence is safe. Off/Initial are the only states
            // nothing is running.
            this.publishProperty('controls_available', state === 0 || state === 5 ? 'online' : 'offline')
            // Remote Start also needs to stay available while Paused: modelJson has no distinct
            // Resume action, OperationStart is how you resume a paused cycle too (same as
            // pressing Start on the physical panel while paused). Also requires remote_start
            // (option2 bit 7, published below) actually armed on the washer itself - confirmed
            // against the real LG app, which won't start a cycle remotely unless this is
            // engaged on the machine, the same physical-presence safety step as pressing the
            // panel's own Remote Start button first. course_selection isn't gated on this: it
            // only sets which course a later Remote Start press would use, it never sends
            // anything to the device itself.
            this.publishProperty(
                'remote_start_available',
                (state === 0 || state === 5 || state === 6) && option2 & 0x80 ? 'online' : 'offline',
            )
            this.publishProperty('pre_state', STATES[preState] ?? String(preState))
            this.publishProperty('course', AP_COURSE[apCourse] ?? String(apCourse))
            this.publishProperty('op_course', OP_COURSE[opCourse] ?? String(opCourse))
            this.residentSmartCourseId = smartCourse
            this.publishProperty('smart_course', SMART_COURSE[smartCourse] ?? '-')
            this.publishProperty('soil', SOIL[soil] ?? String(soil))
            this.publishProperty('spin', SPIN[spin] ?? String(spin))
            this.publishProperty('temp', TEMP[temp] ?? String(temp))
            this.publishProperty('dry_level', DRY_LEVEL[dryLevel] ?? String(dryLevel))
            this.publishProperty('rinse_count', RINSE_COUNT[rinseCount] ?? String(rinseCount))
            this.publishProperty('extra_rinse_count', RINSE_COUNT[extraRinseCount] ?? String(extraRinseCount))
            this.publishProperty('child_lock', option1 & 0x01 ? 'ON' : 'OFF')
            this.publishProperty('steam', option1 & 0x04 ? 'ON' : 'OFF')
            this.publishProperty('prewash', option1 & 0x08 ? 'ON' : 'OFF')
            this.publishProperty('turbowash', option1 & 0x80 ? 'ON' : 'OFF')
            this.publishProperty('extra_rinse', option1 & 0x40 ? 'ON' : 'OFF')
            this.publishProperty('fresh_care', option2 & 0x01 ? 'ON' : 'OFF')
            this.publishProperty('coldwash', option2 & 0x10 ? 'ON' : 'OFF')
            this.publishProperty('remote_start', option2 & 0x80 ? 'ON' : 'OFF')
            this.publishProperty('initial_bit', option3 & 0x20 ? 'ON' : 'OFF')
            this.publishProperty('option3_raw', option3)
            this.publishProperty('tub_clean_count', tclCount)
            this.publishProperty('load_level', loadLevel)
            this.publishProperty('reserve_time', reserveH * 60 + reserveM)
            this.publishProperty('initial_time', timeInitial)
            this.publishProperty('remaining_time', timeRemain)

            // Keep the pending course-to-start in sync with whatever's actually dialed in on
            // the machine, as long as nobody's picked a different one via HA yet. A resident
            // SmartCourse reports APCourse=10, which isn't in COURSE_DEFAULTS - deliberately
            // left unhandled here, since SmartCourse names aren't selectable options any more
            // (see the header comment); course_selection just keeps showing its last valid
            // value in that case rather than publishing something HA would reject.
            if (!this.courseSelectedByUser && COURSE_DEFAULTS[apCourse]) {
                this.pendingCourseId = apCourse
                this.publishProperty('course_selection', AP_COURSE[apCourse])
            }
        })

        // Confirmed against a real captured report: diagMonType "WasherMonitoring" wraps a
        // base64'd XML blob with one of several inner elements —
        // tubInfo (idle tub-clean counter, redundant with byte 21 above), courseInfo (a
        // mid-cycle mirror of the same 24-byte Monitoring frame), and energyMonInfo (the one
        // that matters: course/power/useDate for a just-completed cycle). Only energyMonInfo
        // is handled here; the other two don't carry anything we don't already have.
        thinq.on('diagmon', (diagMonType, decoded) => {
            if (diagMonType !== 'WasherMonitoring') return

            const info = (
                decoded as { lgedmRoot?: { energyMonInfo?: { course?: number; power?: number; useDate?: string } } }
            )?.lgedmRoot?.energyMonInfo
            if (!info) return

            if (typeof info.power === 'number') this.publishProperty('last_cycle_energy', info.power)
            if (typeof info.course === 'number')
                this.publishProperty('last_cycle_course', AP_COURSE[info.course] ?? String(info.course))
            if (typeof info.useDate === 'string') this.publishProperty('last_cycle_completed', info.useDate)
        })
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    pendingCourseId = DEFAULT_COURSE_ID
    courseSelectedByUser = false
    // Set by smart_course, cleared by course_selection - mutually exclusive with
    // pendingCourseId's AP-course pick, since remote_start_button needs to know which of the
    // two encodings (and which real Soil/SpinSpeed/WaterTemp) to actually send.
    pendingSmartCourseId: number | undefined = undefined
    // Whatever the machine actually reports as resident right now (byte 20, kept in sync by
    // the data handler below) - used so writing the same SmartCourse that's already loaded
    // is a no-op instead of re-triggering a real, unnecessary download.
    residentSmartCourseId = 0

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power' && mqttValue === 'OFF') {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' })
        }
        // power=ON is intentionally not implemented: the modelJson defines no PowerOn
        // action for this model, only PowerOff/OperationStart/OperationStop.
        if (prop === 'pause') {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' })
        }
        if (prop === 'course_selection') {
            const id = Number(
                Object.keys(SELECTABLE_COURSE_NAMES).find((key) => SELECTABLE_COURSE_NAMES[Number(key)] === mqttValue),
            )
            if (SELECTABLE_COURSE_NAMES[id]) {
                this.pendingCourseId = id
                this.pendingSmartCourseId = undefined
                this.courseSelectedByUser = true
                this.publishProperty('course_selection', mqttValue)
            }
        }
        if (prop === 'remote_start_button') {
            const data =
                this.pendingSmartCourseId !== undefined
                    ? encodeCourse(
                          SMART_COURSE_AP_COURSE,
                          this.pendingSmartCourseId,
                          SMART_COURSE_DEFAULTS[this.pendingSmartCourseId],
                      )
                    : encodeCourseStart(this.pendingCourseId)
            if (data)
                this.thinq.send({ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Start', Format: 'B64', Data: data })
        }
        if (prop === 'smart_course') {
            // Picking a course here both selects it (for remote_start_button, same as
            // course_selection) and triggers a real download - a plain HA select, no
            // separate confirm button, since download is easily reversible (just re-pick).
            // Deliberately doesn't publishProperty optimistically: unlike course_selection's
            // AP pick (purely local, no round-trip), a SmartCourse download is a real
            // asynchronous exchange with the device - this stays showing the previous
            // resident course until the data handler confirms the new one actually loaded.
            const id = Number(Object.keys(SMART_COURSE).find((key) => SMART_COURSE[Number(key)] === mqttValue))
            if (SMART_COURSE_DEFAULTS[id]) {
                this.pendingSmartCourseId = id
                if (id !== this.residentSmartCourseId) {
                    this.thinq.send({
                        Cmd: 'InfoAlarm',
                        CmdOpt: 'Course',
                        Format: 'B64',
                        Data: encodeCourseDownloadTrigger(id),
                    })
                }
            }
        }
    }
}
