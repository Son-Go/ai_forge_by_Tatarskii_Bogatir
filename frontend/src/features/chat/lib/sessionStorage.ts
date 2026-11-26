import type { MessageInput } from '../../../shared/api/types'

export interface PendingMessage { sessionId: string; input: MessageInput; turnId?: string; retryable?: boolean }
export interface ChatStorage {
  getSession(): string | null
  setSession(id: string): void
  getPending(): PendingMessage | null
  setPending(value: PendingMessage | null): void
}

export function browserStorage(namespace: string): ChatStorage {
  const key = `softline:${namespace}`
  let memorySession: string | null = null
  let memoryPending: PendingMessage | null = null
  return {
    getSession() { try { return localStorage.getItem(`${key}:session`) || memorySession } catch { return memorySession } },
    setSession(id) { memorySession = id; try { localStorage.setItem(`${key}:session`, id) } catch { /* Memory fallback. */ } },
    getPending() {
      try {
        const v: unknown = JSON.parse(sessionStorage.getItem(`${key}:pending`) || 'null')
        if (typeof v === 'object' && v !== null && 'sessionId' in v && typeof v.sessionId === 'string'
          && 'input' in v && typeof v.input === 'object' && v.input !== null
          && 'text' in v.input && typeof v.input.text === 'string'
          && 'client_message_id' in v.input && typeof v.input.client_message_id === 'string') return v as PendingMessage
      } catch { /* Memory fallback. */ }
      return memoryPending
    },
    setPending(value) {
      memoryPending = value
      try {
        if (value) sessionStorage.setItem(`${key}:pending`, JSON.stringify(value))
        else sessionStorage.removeItem(`${key}:pending`)
      } catch { /* Memory fallback. */ }
    },
  }
}
