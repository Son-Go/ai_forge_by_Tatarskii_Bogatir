import type { MessageInput } from '../../../shared/api/types'

export interface PendingMessage { sessionId: string; input: MessageInput; turnId?: string; retryable?: boolean }
export interface RecentSession { id: string; updatedAt: string }
export const recentSessionLimit = 3
export interface ChatStorage {
  getSession(): string | null
  setSession(id: string | null): void
  getRecent(): RecentSession[]
  setRecent(sessions: RecentSession[]): void
  getPending(id: string): PendingMessage | null
  setPending(id: string, value: PendingMessage | null): void
}

function readPending(value: string | null, id: string): PendingMessage | null {
  const v: unknown = JSON.parse(value || 'null')
  if (typeof v !== 'object' || v === null || !('sessionId' in v) || v.sessionId !== id
    || !('input' in v) || typeof v.input !== 'object' || v.input === null
    || !('text' in v.input) || typeof v.input.text !== 'string'
    || !('client_message_id' in v.input) || typeof v.input.client_message_id !== 'string') return null
  return v as PendingMessage
}

function isRecentSession(value: unknown): value is RecentSession {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.id)
    && 'updatedAt' in value && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
}

export function browserStorage(namespace: string): ChatStorage {
  const key = `softline:${namespace}`
  const pendingKey = `${key}:pending`
  let memorySession: string | null = null
  let memoryRecent: RecentSession[] = []
  const memoryPending = new Map<string, PendingMessage>()
  return {
    getSession() { try { return localStorage.getItem(`${key}:session`) || memorySession } catch { return memorySession } },
    setSession(id) {
      memorySession = id
      try {
        if (id) localStorage.setItem(`${key}:session`, id)
        else localStorage.removeItem(`${key}:session`)
      } catch { /* Memory fallback. */ }
    },
    getRecent() {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(`${key}:recent`) || 'null')
        if (Array.isArray(value)) return value.filter(isRecentSession).slice(0, recentSessionLimit)
      } catch { /* Memory fallback. */ }
      return memoryRecent
    },
    setRecent(sessions) {
      memoryRecent = sessions.map(({ id, updatedAt }) => ({ id, updatedAt })).slice(0, recentSessionLimit)
      try { localStorage.setItem(`${key}:recent`, JSON.stringify(memoryRecent)) } catch { /* Memory fallback. */ }
    },
    getPending(id) {
      try {
        const saved = readPending(sessionStorage.getItem(`${pendingKey}:${id}`), id)
          ?? readPending(sessionStorage.getItem(pendingKey), id)
        if (saved) return saved
      } catch { /* Memory fallback. */ }
      return memoryPending.get(id) ?? null
    },
    setPending(id, value) {
      if (value) memoryPending.set(id, value)
      else memoryPending.delete(id)
      try {
        if (value) sessionStorage.setItem(`${pendingKey}:${id}`, JSON.stringify(value))
        else sessionStorage.removeItem(`${pendingKey}:${id}`)
        if (readPending(sessionStorage.getItem(pendingKey), id)) sessionStorage.removeItem(pendingKey)
      } catch { /* Memory fallback. */ }
    },
  }
}
