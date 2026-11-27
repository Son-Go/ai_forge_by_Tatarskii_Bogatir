import { createParser } from 'eventsource-parser'
import { parseEvent } from './guards'
import type { ChatEvent } from './types'

export async function readChatStream(
  response: Response, onEvent: (event: ChatEvent) => void, onBytes?: () => void,
): Promise<void> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
    throw new Error('Сервис не открыл поток ответа')
  }
  let terminal = false
  let accepted = false
  let turnId = ''
  let seq = 0
  const parser = createParser({
    maxBufferSize: 1024 * 1024,
    onEvent(event) {
      if (terminal) return
      const type = event.event || 'message'
      if (!['accepted', 'status', 'delta', 'done', 'failed'].includes(type)) return
      const value: unknown = JSON.parse(event.data)
      const parsed = parseEvent(type, value)
      if (!parsed) return
      if (parsed.type === 'accepted') {
        if (accepted) throw new Error('Повторное принятие хода в потоке')
        accepted = true
        turnId = parsed.data.turn_id
      } else if (!accepted) throw new Error('Поток начался без подтверждения запроса')
      if ((parsed.type === 'done' || parsed.type === 'failed') && parsed.data.turn_id !== turnId) {
        throw new Error('Ответ относится к другому ходу')
      }
      if (parsed.type === 'delta') {
        if (parsed.data.seq <= seq) return
        if (parsed.data.seq !== seq + 1) throw new Error('Пропущен фрагмент ответа')
        seq = parsed.data.seq
      }
      terminal = parsed.type === 'done' || parsed.type === 'failed'
      onEvent(parsed)
    },
    onError(error) { throw error },
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (!terminal) {
      const { value, done } = await reader.read()
      if (done) { parser.feed(decoder.decode()); break }
      onBytes?.()
      parser.feed(decoder.decode(value, { stream: true }))
    }
    if (!terminal) throw new Error('Соединение прервано до завершения ответа')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
