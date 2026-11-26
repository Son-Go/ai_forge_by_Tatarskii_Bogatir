import type { ApiErrorBody, ChatEvent, Message, Offer, Session, Source } from './types'

type RecordValue = Record<string, unknown>
const object = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: RecordValue, keys: string[]) => keys.every((key) => typeof v[key] === 'string')
const list = <T>(v: unknown, guard: (item: unknown) => item is T): v is T[] => Array.isArray(v) && v.every(guard)
const includes = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v)
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))

export function isOffer(v: unknown): v is Offer {
  if (!object(v) || !strings(v, ['offer_id', 'catalog_version', 'name', 'product_url'])) return false
  const price = v.price
  return (price === null || (object(price) && typeof price.amount === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(price.amount)
    && typeof price.currency === 'string' && /^[A-Z]{3}$/.test(price.currency)))
    && includes(v.availability, ['available', 'unavailable', 'unknown']) && object(v.attributes)
    && list(v.source_ids, (x): x is string => typeof x === 'string')
}
export function isSource(v: unknown): v is Source {
  return object(v) && strings(v, ['id', 'title', 'url']) && includes(v.kind, ['catalog', 'store', 'knowledge'])
    && (date(v.snapshot_at) || date(v.checked_at))
    && (v.snapshot_at === undefined || date(v.snapshot_at)) && (v.checked_at === undefined || date(v.checked_at))
}
export function isMessage(v: unknown): v is Message {
  return object(v) && strings(v, ['id', 'text']) && includes(v.role, ['user', 'assistant'])
    && date(v.created_at) && list(v.cards, isOffer) && list(v.sources, isSource)
    && (v.status === undefined || includes(v.status, ['streaming', 'complete', 'partial']))
}
export function isSession(v: unknown): v is Session {
  if (!object(v) || typeof v.session_id !== 'string' || typeof v.quotes_enabled !== 'boolean') return false
  const turn = v.last_turn
  return list(v.messages, (m): m is Session['messages'][number] => isMessage(m) && m.status !== undefined)
    && (v.selected_offer === null || isOffer(v.selected_offer))
    && (turn === null || (object(turn) && typeof turn.turn_id === 'string'
      && includes(turn.status, ['running', 'complete', 'failed'])))
}
export function isApiError(v: unknown): v is ApiErrorBody {
  return object(v) && strings(v, ['code', 'message', 'request_id'])
    && (v.updated_offer === undefined || isOffer(v.updated_offer))
    && (v.turn_id === undefined || typeof v.turn_id === 'string')
}

export function parseEvent(type: string, value: unknown): ChatEvent | null {
  if (!['accepted', 'status', 'delta', 'done', 'failed'].includes(type)) return null
  if (!object(value)) throw new Error('Некорректное событие сервера')
  let valid = false
  switch (type) {
    case 'accepted': valid = strings(value, ['turn_id', 'client_message_id', 'user_message_id', 'request_id']); break
    case 'status': valid = includes(value.stage, ['interpreting', 'searching', 'generating']); break
    case 'delta': valid = Number.isInteger(value.seq) && Number(value.seq) > 0 && typeof value.text === 'string' && value.text.length > 0; break
    case 'done': valid = typeof value.turn_id === 'string' && includes(value.outcome, ['clarify', 'recommend', 'answer', 'insufficient_data'])
      && isMessage(value.message) && value.message.role === 'assistant'; break
    case 'failed': valid = strings(value, ['turn_id', 'code', 'message']) && typeof value.retryable === 'boolean'; break
  }
  if (!valid) throw new Error(`Некорректное событие ${type}`)
  // Each discriminated branch was checked above, at the network boundary.
  return { type, data: value } as ChatEvent
}
