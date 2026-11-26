import type { Message, Offer, Source } from '../../shared/api/types'

// UI model for the isolated local demo; this is not a proposed public API contract.
export const handoffReasons = {
  price: 'Уточнение цены',
  documents: 'Проверка документов',
  supply: 'Поставка вне каталога',
  complex: 'Сложный вопрос',
} as const
export type HandoffReason = keyof typeof handoffReasons
export type CaseStatus = 'waiting' | 'in_progress'
export const caseStatuses: Record<CaseStatus, string> = { waiting: 'Ожидает решения', in_progress: 'В работе' }
export interface HandoffCase {
  id: string
  sessionId: string
  title: string
  reason: HandoffReason
  explanation: string
  status: CaseStatus
  createdAt: string
  requirements: { label: string; value: string | null; evidence: string }[]
  messages: Message[]
  offers: Offer[]
  sources: Source[]
}
