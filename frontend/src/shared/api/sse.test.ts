import { describe, expect, it } from 'vitest'
import clarify from '../../../../contracts/examples/public-clarify.sse?raw'
import recommend from '../../../../contracts/examples/public-recommend.sse?raw'
import failed from '../../../../contracts/examples/public-failed.sse?raw'
import { readChatStream } from './sse'
import type { ChatEvent } from './types'

function response(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
describe('SSE transport', () => {
  it.each([clarify, recommend, failed])('reads contract examples split at every byte', async (example) => {
    const events: ChatEvent[] = []
    await readChatStream(response(example), (e) => events.push(e))
    expect(events[0]?.type).toBe('accepted')
    expect(['done', 'failed']).toContain(events.at(-1)?.type)
    expect(events.some((e) => e.type === 'delta' && e.data.text.includes('�'))).toBe(false)
  })
  it('supports CRLF, multiline data, heartbeats, unknown events and combined chunks', async () => {
    const text = clarify.replace('event: status\ndata: {"stage":"searching"}', ': heartbeat\n\nevent: future\ndata: invalid-json\n\nevent: status\ndata: {\ndata: "stage":"searching"}').replaceAll('\n', '\r\n')
    const events: ChatEvent[] = []
    await readChatStream(response(text, 10000), (e) => events.push(e))
    expect(events.map((e) => e.type)).toEqual(['accepted', 'status', 'delta', 'done'])
  })
  it('reports heartbeat bytes as stream activity', async () => {
    const events: ChatEvent[] = []
    let liveChunks = 0
    await readChatStream(response(`: waiting\n\n${clarify}`, 11), (event) => events.push(event), () => { liveChunks += 1 })
    expect(events.map((event) => event.type)).toEqual(['accepted', 'status', 'delta', 'done'])
    expect(liveChunks).toBeGreaterThan(events.length)
  })
  it('ignores duplicate deltas and uses the final persisted message', async () => {
    const delta = clarify.match(/event: delta\ndata: .*\n\n/)![0]
    const events: ChatEvent[] = []
    await readChatStream(response(clarify.replace(delta, delta + delta)), (e) => events.push(e))
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(1)
  })
  it('detects sequence gaps, malformed JSON, invalid fields and unexpected EOF', async () => {
    await expect(readChatStream(response(clarify.replace('"seq":1', '"seq":2')), () => {})).rejects.toThrow('Пропущен')
    await expect(readChatStream(response(clarify.replace('"stage":"searching"', 'broken')), () => {})).rejects.toThrow()
    await expect(readChatStream(response(clarify.replace('"stage":"searching"', '"stage":"unknown"')), () => {})).rejects.toThrow('Некорректное')
    await expect(readChatStream(response(clarify.split('event: done')[0]!), () => {})).rejects.toThrow('прервано')
  })
  it('rejects an unrelated turn and non-SSE response', async () => {
    await expect(readChatStream(response(clarify.replace('event: done\ndata: {"turn_id":"e3d1701c-1210-4706-94cb-2b9ec088da3d"', 'event: done\ndata: {"turn_id":"wrong"')), () => {})).rejects.toThrow('другому ходу')
    await expect(readChatStream(new Response('{}'), () => {})).rejects.toThrow('не открыл')
  })
})
