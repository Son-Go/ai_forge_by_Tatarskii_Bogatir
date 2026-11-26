import type { Message, Offer, Source } from '../../shared/api/types'

// Isolated presentation model; no assumptions about the missing manager DTO.
// Status identifiers are confirmed by the Backend developer, not locally generated.
export const handoffReasons = {
  document_review: 'Проверка документов',
  off_catalog_order: 'Заказ вне каталога',
  price: 'Уточнение цены',
  documents: 'Проверка документов',
  supply: 'Поставка вне каталога',
  complex: 'Сложный вопрос',
} as const
export type HandoffReason = keyof typeof handoffReasons
export type CaseStatus = 'queued' | 'in_progress' | 'resolved'
export const caseStatuses: Record<CaseStatus, string> = { queued: 'Ожидает решения', in_progress: 'В работе', resolved: 'Завершено' }
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
