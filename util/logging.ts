let filter = (_: string) => true

// Listeners for the management panel's activity feed (see management/index.ts's /logs
// route). Deliberately separate from the console.log/filter path above: filter controls what
// reaches the container's own stdout, while listeners let an opt-in WS client see a topic it
// wouldn't otherwise, without changing what gets logged to the console.
type LogListener = (ts: number, topic: string, args: unknown[]) => void
const listeners = new Set<LogListener>()

export default function log(topic: string, ...args: any) {
    const ts = Date.now()
    if (filter(topic)) console.log(new Date(ts), topic, ...args)
    for (const listener of listeners) listener(ts, topic, args)
}

export function setFilter(newFilter: (_: string) => boolean) {
    filter = newFilter
}

// Returns an unsubscribe function. Listeners see every log() call regardless of the console
// filter above, so a client can watch a topic that's deliberately quiet on stdout.
export function onLog(listener: LogListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
