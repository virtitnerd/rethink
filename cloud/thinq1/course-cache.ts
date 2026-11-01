import { readFileSync, writeFileSync } from 'node:fs'

type CachedCourse = {
    contentType: string
    bodyBase64: string
}

// Real SmartCourse content downloaded once via bridge (see WasherCourseDownloadSvc in
// cloud/thinq1/http.ts) - captured server-to-server from LG's real downUrl and cached here so
// the same course can be handed back to the device again later without bridge/LG at all.
export class CourseCache {
    constructor(private readonly basePath: string) {}

    private path(courseId: string) {
        return `${this.basePath}/course_${encodeURIComponent(courseId)}.json`
    }

    get(courseId: string): { contentType: string; body: Buffer } | undefined {
        try {
            const raw = JSON.parse(readFileSync(this.path(courseId)).toString('utf-8')) as CachedCourse
            return { contentType: raw.contentType, body: Buffer.from(raw.bodyBase64, 'base64') }
        } catch {
            return undefined
        }
    }

    set(courseId: string, contentType: string, body: Buffer) {
        const raw: CachedCourse = { contentType, bodyBase64: body.toString('base64') }
        writeFileSync(this.path(courseId), JSON.stringify(raw))
    }
}
