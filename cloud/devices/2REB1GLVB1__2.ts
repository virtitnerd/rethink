import { TemperatureUnit, unpackStatus } from './fridge_common'
import Base from './2RES1VE61NFA2'
export const platform = 'thinq2'

// The LG app's F017 command for Eco Friendly, captured through the rethink bridge: 41 bytes, all
// 0xFF ("leave unchanged") except the ecoFriendly byte and these.
const APP_COMMAND_FIXED: Record<number, number> = {
    21: 0x00,
    22: 0x00,
    23: 0x00,
    26: 0x00,
    31: 0x00,
}
const APP_COMMAND_LENGTH = 41
const ECO_FRIENDLY = 12

// The 2RES1VE61NFA2 fridge with a shorter status record and the Eco Friendly switch.
export default class Device extends Base {
    protected override readonly statusLength = 17

    protected override components(unit: TemperatureUnit) {
        return {
            ...super.components(unit),
            eco_friendly: {
                platform: 'switch',
                unique_id: '$deviceid-eco_friendly',
                state_topic: '$this/eco_friendly',
                command_topic: '$this/eco_friendly/set',
                icon: 'mdi:leaf',
                name: 'Eco Friendly',
            },
        }
    }

    processStatus(curStatus: Buffer) {
        super.processStatus(curStatus)
        this.publishProperty('eco_friendly', unpackStatus(curStatus).ecoFriendly === 1 ? 'ON' : 'OFF')
    }

    appCommand(fields: Record<number, number>) {
        const payload = Buffer.alloc(APP_COMMAND_LENGTH, 0xff)
        for (const [index, value] of Object.entries({ ...APP_COMMAND_FIXED, ...fields })) payload[Number(index)] = value
        this.send(Buffer.concat([Buffer.from('F017', 'hex'), payload]))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'eco_friendly') this.appCommand({ [ECO_FRIENDLY]: mqttValue === 'ON' ? 1 : 0 })
        else super.setProperty(prop, mqttValue)
    }
}
