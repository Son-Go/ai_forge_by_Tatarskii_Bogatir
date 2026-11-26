import { handoffReasons, type HandoffCase, type HandoffReason } from '../../entities/handoff/types'
import { isMessage, isOffer, isSource } from '../../shared/api/guards'
import type { Session } from '../../shared/api/types'
import { attributes } from '../../shared/lib/presentation'
import { demoCases } from './fixtures'

const storageKey = 'softline:demo:handoffs:v1'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function isCase(value: unknown): value is HandoffCase {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && /^DEMO-[A-Z0-9-]+$/.test(value.id)
    && ['sessionId', 'title', 'explanation'].every((key) => typeof value[key] === 'string')
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.reason === 'string' && Object.hasOwn(handoffReasons, value.reason)
    && ['waiting', 'in_progress'].includes(String(value.status))
    && Array.isArray(value.messages) && value.messages.every(isMessage)
    && Array.isArray(value.offers) && value.offers.every(isOffer)
    && Array.isArray(value.sources) && value.sources.every(isSource)
    && Array.isArray(value.requirements) && value.requirements.every((item) => isRecord(item)
      && typeof item.label === 'string' && typeof item.evidence === 'string'
      && (item.value === null || typeof item.value === 'string'))
}

export function createDemoCaseStore(storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {
  let snapshot: HandoffCase[] | null = null
  const memoryOnly = new Set<string>()
  const listeners = new Set<() => void>()
  function getSnapshot(): HandoffCase[] {
    if (snapshot) return snapshot
    try {
      const value: unknown = JSON.parse(storage().getItem(storageKey) || 'null')
      if (Array.isArray(value) && value.every(isCase)) snapshot = value
    } catch { /* Corrupt or unavailable demo storage uses known synthetic fixtures. */ }
    return snapshot ??= structuredClone(demoCases)
  }
  return {
    getSnapshot,
    isPersistent(id: string) { return !memoryOnly.has(id) },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    register(session: Session, reason: HandoffReason) {
      const previous = getSnapshot().find((item) => item.sessionId === session.session_id)
      if (previous) return { record: previous, persisted: !memoryOnly.has(previous.id), existing: true }
      const offers = [...new Map(session.messages.flatMap((message) => message.cards)
        .map((offer) => [`${offer.offer_id}:${offer.catalog_version}`, offer])).values()]
      const sources = [...new Map(session.messages.flatMap((message) => message.sources).map((source) => [source.id, source])).values()]
      const lastQuestion = [...session.messages].reverse().find((message) => message.role === 'user')
      const record: HandoffCase = {
        id: `DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        sessionId: session.session_id, title: session.selected_offer?.name || lastQuestion?.text.slice(0, 100) || 'Запрос специалисту',
        reason, explanation: `Клиент запросил участие специалиста: ${handoffReasons[reason].toLowerCase()}. Контекст сохранён на момент локальной регистрации.`,
        status: 'waiting', createdAt: new Date().toISOString(), messages: structuredClone(session.messages),
        offers: structuredClone(offers), sources: structuredClone(sources),
        requirements: session.selected_offer ? attributes(session.selected_offer).map(([label, value]) => ({
          label, value: value === 'Требует уточнения' ? null : value, evidence: 'Из выбранного предложения. Полное состояние требований отсутствует в публичном API.',
        })) : [{ label: 'Требования клиента', value: null, evidence: 'Смотрите точные формулировки в истории. Структурированные требования не передаются публичным API.' }],
      }
      snapshot = [record, ...getSnapshot()]
      let persisted = true
      try { storage().setItem(storageKey, JSON.stringify(snapshot)); memoryOnly.clear() }
      catch { persisted = false; memoryOnly.add(record.id) }
      listeners.forEach((listener) => listener())
      return { record, persisted, existing: false }
    },
  }
}

export const demoCaseStore = createDemoCaseStore()
