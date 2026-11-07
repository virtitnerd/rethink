import { Enum } from '@/util/enum'
import Base from './RV13B6BSD_D_US_WIFI'
export const platform = 'thinq2'

// LG electric dryer — matched on modelId "RV13B6ES_D_US_WIFI". Frame layout is identical to its close
// relative RV13B6BSD_D_US_WIFI (see that file): AABB frames (buf = the AABB body, AA+len and
// checksum+BB already stripped) start with 0x30 and are discriminated by buf[1]:
//   0xEC        dial/status frame — two stacked records (29-byte old state, 28-byte current state), each
//               starting with a 0x1b marker; we read the current-state record (buf[32:]).
//   0xEB        single-record status frame (28-byte record at buf[3:]) — same field layout as 0xEC's
//               current-state record, seen right after the appliance (re)connects.
//   0x31/0xE2/0xD8/0x72  serial, idle snapshot and heartbeat frames — not decoded.
//
// This model is NOT a straight alias of RV13B6BSD_D_US_WIFI. Two differences were found by live capture:
//   * Wrinkle Care lives in rec[15] bit 0x10, not rec[16] bit 0x10. Aliasing to the relative would have
//     silently reported Wrinkle Care as permanently OFF, because rec[16] bit 0x10 is never set here.
//   * rec[23] carries a "load item" count that the relative does not decode at all.
//
// Every offset and table entry below was confirmed live: captured real wire traffic while driving the
// physical dryer and correlated each byte change against the LG cloud's own decoded washerDryer state at
// matching timestamps — not guessed from static analysis. The course/dry-level/temperature tables were
// derived mechanically from those pairings rather than copied.

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request —
// the fridges, the EU washers and the US WashTower all use it; actuating commands are 0xF0E5,
// so this only ever reads. Confirmed on a live RV13B6ES: the dryer answered within a second
// with a 0xEB snapshot, then resumed normal 0xEC updates.
const STATUS_REQUEST = 'F0ED1121010000001800'

// rec[11]: the Signal (end-of-cycle beeper) setting. This one is NOT cloud-confirmed like everything else
// in this file — the LG cloud sends no signal field for this dryer at all (verified against a full
// allDeviceInfoUpdate snapshot). It was mapped from the wire alone: pressing Signal cycles the byte
// 0x00 -> 0x01 -> 0x04 -> 0x00 with nothing else in the record moving, and the three values were tied to
// the panel's own Off/Low/High indicator by reading the lit LED after each press.
const SIGNAL_OFFSET = 11

// rec[12]: the More/Less Time adjustment, a SIGNED byte holding the number of minutes added to or
// removed from the course's default time. Confirmed against the cloud's moreLessTime (which reports the
// same byte unsigned) across a Speed Dry trimmed from its 25-minute default down to 10:
// 0xfe/-2 -> 23 min, 0xf9/-7 -> 18, 0xf6/-10 -> 15, 0xf1/-15 -> 10. Every value matched 25 + offset.
const MORE_LESS_TIME_OFFSET = 12

// Confirmed across six clean on/off transitions, matching the cloud's wrinkleCare exactly, observed both
// with and without the 0x40 base bit present. This is the offset that differs from RV13B6BSD_D_US_WIFI.
const FLAG_WRINKLE_CARE = 0x10

// Remote Start. RV13B6BSD_D_US_WIFI documents this as not findable in any device frame ("appears
// cloud-side only"); on this model it is rec[16] bit 0x01, isolated cleanly when the bit flipped in a
// frame that changed nothing else and the cloud reported remoteStart:"REMOTE_START_ON" 300ms later.
const OPT2_REMOTE_START = 0x01

// rec[23]: literal count of "load items", matching the cloud's loadItem (LOADITEM_OFF/2/5 seen as
// 0x00/0x02/0x05). Not decoded by RV13B6BSD_D_US_WIFI.
const LOAD_ITEM_OFFSET = 23

const SIGNAL = Enum.of({
    Off: 0x00,
    Low: 0x01,
    High: 0x04,
})

// Course identifier -> name, derived from the capture by pairing rec[6] with the cloud's
// courseDryer27inchBase at matching timestamps. All 14 values below were observed on this appliance.
// 'Super Dry' is the Downloaded Cycle dial position, which reports whichever smart course is loaded
// into it (the cloud confirmed it as both courseDryer27inchBase and smartCourseDryer27inchBase).
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    Antibacterial: 0x08,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': 0x12,
    'Steam Fresh': 0x15,
    'Steam Sanitary': 0x16,
    'Super Dry': 0x1a,
})

export default class Device extends Base {
    protected override readonly course: Pick<typeof COURSE, 'map'> = COURSE

    protected override components() {
        return {
            ...super.components(),
            more_less_time: {
                platform: 'sensor',
                unique_id: '$deviceid-more_less_time',
                state_topic: '$this/more_less_time',
                name: 'More/Less time',
                icon: 'mdi:plus-minus-variant',
                device_class: 'duration',
                unit_of_measurement: 'min',
                entity_category: 'diagnostic',
            },
            remote_start: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-remote_start',
                state_topic: '$this/remote_start',
                name: 'Remote start',
                icon: 'mdi:cellphone-wireless',
                entity_category: 'diagnostic',
            },
            load_item: {
                platform: 'sensor',
                unique_id: '$deviceid-load_item',
                state_topic: '$this/load_item',
                name: 'Load items',
                icon: 'mdi:tshirt-crew-outline',
                state_class: 'measurement',
            },
            signal: {
                platform: 'sensor',
                unique_id: '$deviceid-signal',
                state_topic: '$this/signal',
                name: 'Signal',
                icon: 'mdi:bell-outline',
                entity_category: 'diagnostic',
            },
        }
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    protected override publishOptions(flags: number, opt2: number) {
        this.publishProperty('wrinkle_care', (flags & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
    }

    protected override publishExtras(rec: Buffer, isOff: boolean) {
        this.publishProperty('load_item', rec[LOAD_ITEM_OFFSET])
        this.publishProperty('signal', SIGNAL.map(rec[SIGNAL_OFFSET]))
        this.publishProperty('more_less_time', isOff ? 0 : rec.readInt8(MORE_LESS_TIME_OFFSET))
    }
}
