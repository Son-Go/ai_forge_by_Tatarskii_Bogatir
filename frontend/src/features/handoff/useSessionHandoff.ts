import { useEffect, useState } from 'react'
import { handoffApi, type Handoff } from '../../shared/api/handoffApi'
import type { ChatController } from '../chat/model/ChatController'
import type { ChatState } from '../chat/model/chatReducer'

export function useSessionHandoff(state: ChatState, controller: ChatController) {
  const id = state.session?.session_id
  const ready = state.phase === 'ready'
  const turn = state.session?.last_turn?.turn_id
  const [result, setResult] = useState<{ id?: string; handoff: Handoff | null; issue: string }>({ handoff: null, issue: '' })
  useEffect(() => {
    if (!id || !ready) return
    const operation = new AbortController()
    let timer = 0
    async function read() {
      try {
        if (document.visibilityState === 'hidden') { timer = window.setTimeout(() => void read(), 5000); return }
        const { handoff } = await handoffApi.getSession(id!, operation.signal)
        if (operation.signal.aborted) return
        // Refresh saved manager replies even on the final resolved observation.
        if (handoff) await controller.refreshHistory(operation.signal)
        if (operation.signal.aborted) return
        setResult({ id, handoff, issue: '' })
        if (handoff && handoff.status !== 'resolved') timer = window.setTimeout(() => void read(), 5000)
      } catch {
        if (!operation.signal.aborted) {
          setResult((previous) => ({ id, handoff: previous.id === id ? previous.handoff : null, issue: 'Не удалось обновить статус обращения. Переписка остаётся доступна; повторим проверку.' }))
          timer = window.setTimeout(() => void read(), 5000)
        }
      }
    }
    void read()
    return () => { operation.abort(); clearTimeout(timer) }
  }, [id, ready, turn, controller])
  return result.id === id ? result : { handoff: null, issue: '' }
}
