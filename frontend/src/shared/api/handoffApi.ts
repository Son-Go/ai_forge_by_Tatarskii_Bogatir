import type { components, operations } from './manager-schema'
import { requireOk, jsonRequest } from './client'
import { isMessage } from './guards'
import type { Session } from './types'

export type Handoff = components['schemas']['Handoff']
export type QueueItem = components['schemas']['QueueItem']
export type ManagerReplyInput = operations['replyToHandoff']['requestBody']['content']['application/json']
export type FaqCandidate = components['schemas']['FaqCandidate']
export type FaqApproval = components['schemas']['FaqApproval']
export interface FaqReview { candidate: FaqCandidate | null }
export interface AssignedHandoff { handoff: QueueItem; messages: Session['messages'] }
export const managerQueuePageSize = 50
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown) => typeof v === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v)
export function isHandoff(v: unknown): v is Handoff {
  return record(v) && uuid(v.handoff_id) && ['document_review', 'off_catalog_order'].includes(String(v.reason))
    && ['queued', 'in_progress', 'resolved'].includes(String(v.status)) && typeof v.created_at === 'string' && Number.isFinite(Date.parse(v.created_at))
}
export const isQueueItem = (v: unknown): v is QueueItem => isHandoff(v) && 'session_id' in v && uuid(v.session_id)
export const isAssignedHandoff = (v: unknown): v is AssignedHandoff => record(v) && isQueueItem(v.handoff)
  && Array.isArray(v.messages) && v.messages.every((message) => isMessage(message) && message.status !== undefined)

const faqStatuses = ['queued', 'published', 'needs_review', 'case_specific', 'rejected', 'unpublished']
const optionalText = (v: unknown) => v == null || typeof v === 'string'
const isFaqCandidate = (v: unknown): v is FaqCandidate => record(v) && uuid(v.candidate_id)
  && typeof v.status === 'string' && faqStatuses.includes(v.status)
  && typeof v.attempts === 'number' && Number.isInteger(v.attempts) && v.attempts >= 0
  && [v.reason_code, v.question, v.answer, v.product, v.edition].every(optionalText)
  && (v.source_id == null || uuid(v.source_id))
  && Array.isArray(v.sources) && v.sources.every((source) => record(source) && uuid(source.id)
    && typeof source.title === 'string' && typeof source.url === 'string' && typeof source.text === 'string')
const isFaqReview = (v: unknown): v is FaqReview => record(v) && (v.candidate === null || isFaqCandidate(v.candidate))

async function managerRequest<T>(path: string, token: string, guard: (v: unknown) => v is T, signal: AbortSignal, body?: ManagerReplyInput | FaqApproval, post = false): Promise<T> {
  const response = await requireOk(await fetch(new URL(path, location.origin), {
    method: post ? 'POST' : 'GET', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
  const value: unknown = await response.json()
  if (!guard(value)) throw new Error('Ответ менеджерского API не соответствует контракту.')
  return value
}
const route = (id: string) => `/api/v1/manager/handoffs/${encodeURIComponent(id)}`
export const handoffApi = {
  readFaq: (token: string, id: string, signal: AbortSignal, query?: string) => managerRequest(
    `${route(id)}/faq${query ? `?${new URLSearchParams({ source_query: query })}` : ''}`, token, isFaqReview, signal),
  approveFaq: (token: string, id: string, input: FaqApproval, signal: AbortSignal) =>
    managerRequest(`${route(id)}/faq/approve`, token, isFaqReview, signal, input, true),
  rejectFaq: (token: string, id: string, signal: AbortSignal) =>
    managerRequest(`${route(id)}/faq/reject`, token, isFaqReview, signal, undefined, true),
  unpublishFaq: (token: string, id: string, signal: AbortSignal) =>
    managerRequest(`${route(id)}/faq/unpublish`, token, isFaqReview, signal, undefined, true),
  getSession: (id: string, signal: AbortSignal) => jsonRequest(`/api/v1/sessions/${encodeURIComponent(id)}/handoff`,
    (v): v is { handoff: Handoff | null } => record(v) && (v.handoff === null || isHandoff(v.handoff)), { signal }),
  list: (token: string, offset: number, signal: AbortSignal) => managerRequest(`/api/v1/manager/handoffs?limit=${managerQueuePageSize + 1}&offset=${offset}`, token,
    (v): v is QueueItem[] => Array.isArray(v) && v.every(isQueueItem), signal),
  read: (token: string, id: string, signal: AbortSignal) => managerRequest(route(id), token, isAssignedHandoff, signal),
  claim: (token: string, id: string, signal: AbortSignal) => managerRequest(`${route(id)}/claim`, token, isQueueItem, signal, undefined, true),
  resolve: (token: string, id: string, signal: AbortSignal) => managerRequest(`${route(id)}/resolve`, token, isQueueItem, signal, undefined, true),
  reply: (token: string, id: string, input: ManagerReplyInput, signal: AbortSignal) => managerRequest(`${route(id)}/messages`, token,
    (v): v is Session['messages'][number] => isMessage(v) && v.status !== undefined && v.sender === 'manager' && v.role === 'assistant', signal, input, true),
}
