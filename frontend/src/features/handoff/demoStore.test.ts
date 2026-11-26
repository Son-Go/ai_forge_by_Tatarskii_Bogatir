import { expect, it } from 'vitest'
import { createDemoCaseStore } from './demoStore'
import type { Session } from '../../shared/api/types'
import { demoCases } from './fixtures'

function session(): Session {
  return { session_id: crypto.randomUUID(), quotes_enabled: false, last_turn: null, selected_offer: null,
    messages: [{ id: crypto.randomUUID(), role: 'user', text: 'Нужна проверка условий', cards: [], sources: [], status: 'complete', created_at: new Date().toISOString() }] }
}
it('registers one immutable local snapshot per demo session and restores it', () => {
  const storage = new Map<string, string>()
  const provider = () => ({ getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => { storage.set(key, value) } })
  const store = createDemoCaseStore(provider)
  const source = session()
  const registered = store.register(source, 'documents')
  source.messages[0]!.text = 'Позднее изменение'
  expect(registered.persisted).toBe(true)
  expect(registered.record.messages[0]!.text).toBe('Нужна проверка условий')
  expect(registered.record.requirements[0]!.value).toBeNull()
  expect(store.register(source, 'complex').record.id).toBe(registered.record.id)
  expect(store.getSnapshot()).toHaveLength(demoCases.length + 1)
  expect(createDemoCaseStore(provider).getSnapshot()[0]!.id).toBe(registered.record.id)
})
it('uses safe fixtures for corrupt storage and reports memory-only registration', () => {
  const store = createDemoCaseStore(() => ({ getItem: () => '[{"title":"bad"}]', setItem: () => { throw new Error('Storage denied') } }))
  expect(store.getSnapshot()).toHaveLength(demoCases.length)
  const result = store.register(session(), 'price')
  expect(result.persisted).toBe(false)
  expect(store.isPersistent(result.record.id)).toBe(false)
  expect(store.getSnapshot()[0]!.id).toBe(result.record.id)
})
