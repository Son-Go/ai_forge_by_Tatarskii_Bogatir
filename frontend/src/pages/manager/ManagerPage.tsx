import { useState, type Dispatch, type SetStateAction } from 'react'
import { demoCases } from '../../features/handoff/fixtures'
import { ManagerWorkspace } from './ManagerWorkspace'
import { ManagerConnected } from './ManagerConnected'
import { Icon } from '../../shared/ui/Icon'

export function ManagerPage({ caseId, demo, token: suppliedToken, onTokenChange }: {
  caseId: string | null; demo: boolean; token?: string; onTokenChange?: Dispatch<SetStateAction<string>>
}) {
  const [localToken, setLocalToken] = useState('')
  const [draft, setDraft] = useState('')
  const [issue, setIssue] = useState('')
  const token = suppliedToken ?? localToken
  const setToken = onTokenChange ?? setLocalToken
  if (demo) return <ManagerWorkspace cases={demoCases} caseId={caseId} demo />
  if (token) return <ManagerConnected token={token} caseId={caseId} onLogout={(message = '') => { setToken(''); setDraft(''); setIssue(message) }} />
  return <main className="main manager-main" id="manager-workspace" tabIndex={-1}><section className="manager-empty">
    <span className="empty-icon"><Icon name="shield" /></span><h1>Доступ менеджера</h1>
    <p>Введите выданный Backend токен для работы с очередью. Токен хранится только в памяти до перезагрузки или выхода.</p>
    <form className="manager-login" aria-label="Доступ менеджера" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { setIssue(''); setToken(draft.trim()); setDraft('') } }}>
      <label htmlFor="manager-token">Токен доступа</label><input id="manager-token" type="password" autoComplete="off" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} required />
      <button type="submit" className="accent-action" disabled={!draft.trim()}>Открыть очередь</button>
    </form>
    {issue && <p role="alert">{issue}</p>}
  </section></main>
}
