import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import log, { onLog, setFilter } from '@/util/logging'

describe('logging', () => {
    test('onLog receives topic/args for every log() call', () => {
        const seen: { topic: string; args: unknown[] }[] = []
        const unsubscribe = onLog((ts, topic, args) => {
            assert.equal(typeof ts, 'number')
            seen.push({ topic, args })
        })
        try {
            log('status', 'hello', 42)
            assert.deepEqual(seen, [{ topic: 'status', args: ['hello', 42] }])
        } finally {
            unsubscribe()
        }
    })

    test('unsubscribe stops further notifications', () => {
        let count = 0
        const unsubscribe = onLog(() => {
            count++
        })
        log('status', 'first')
        unsubscribe()
        log('status', 'second')
        assert.equal(count, 1)
    })

    test('multiple listeners are independent', () => {
        let a = 0
        let b = 0
        const unsubA = onLog(() => a++)
        const unsubB = onLog(() => b++)
        try {
            log('status', 'x')
            assert.equal(a, 1)
            assert.equal(b, 1)
            unsubA()
            log('status', 'y')
            assert.equal(a, 1)
            assert.equal(b, 2)
        } finally {
            unsubA()
            unsubB()
        }
    })

    test('listeners fire regardless of the console filter (bypasses setFilter, unlike console.log)', () => {
        // suppresses console.log for this call - also the behavior under test: a listener
        // must still see it even though the filter would otherwise silence stdout.
        setFilter(() => false)
        let seenTopic: string | undefined
        const unsubscribe = onLog((ts, topic) => {
            seenTopic = topic
        })
        try {
            log('quiet-topic', 'still delivered to listeners')
            assert.equal(seenTopic, 'quiet-topic')
        } finally {
            unsubscribe()
            setFilter(() => true) // restore the default so other tests in this process aren't affected
        }
    })
})
