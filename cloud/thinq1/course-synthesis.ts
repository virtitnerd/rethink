import { synthesizeSmartCourseDownload } from '../devices/F3L2CNV4W_WIFI'

type Synthesizer = (courseId: string) => { contentType: string; body: Buffer } | undefined

// Per-model local SmartCourse synthesis, keyed by modelName - mirrors ha_bridge.ts's own
// modelId -> device class dispatch. Deliberately independent of CourseCache/bridge: a model
// registered here needs no real LG download, ever, not even a first one.
const SYNTHESIZERS: Record<string, Synthesizer> = {
    F3L2CNV4W_WIFI: synthesizeSmartCourseDownload,
}

export function synthesizeLocalCourse(
    modelName: string | undefined,
    courseId: string,
): { contentType: string; body: Buffer } | undefined {
    return modelName ? SYNTHESIZERS[modelName]?.(courseId) : undefined
}
