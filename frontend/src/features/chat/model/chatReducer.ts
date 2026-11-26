import type { ChatEvent, Message, Offer, Session } from '../../../shared/api/types'

export type Phase = 'booting' | 'ready' | 'sending' | 'streaming' | 'recovering' | 'selecting' | 'unavailable'
export type Issue = { message: string; action?: 'restore' | 'retry' | 'resend' | 'new-session'; requestId?: string }
export interface ChatState {
  session: Session | null
  phase: Phase
  stage: 'interpreting' | 'searching' | 'generating' | null
  optimistic: Message | null
  streamText: string
  issue: Issue | null
  updatedOffer: Offer | null
  rejectedText: string | null
}
export const initialState: ChatState = {
  session: null, phase: 'booting', stage: null, optimistic: null, streamText: '', issue: null, updatedOffer: null, rejectedText: null,
}
export type Action =
  | { type: 'patch'; value: Partial<ChatState> }
  | { type: 'session'; session: Session }
  | { type: 'event'; event: ChatEvent }
  | { type: 'reset' }

export function chatReducer(state: ChatState, action: Action): ChatState {
  if (action.type === 'reset') return { ...initialState }
  if (action.type === 'patch') return { ...state, ...action.value }
  if (action.type === 'session') return {
    ...state, session: action.session, phase: action.session.last_turn?.status === 'running' ? 'recovering' : 'ready',
    optimistic: null, streamText: '', stage: null,
  }
  const { event } = action
  switch (event.type) {
    case 'accepted': return { ...state, phase: 'streaming', optimistic: state.optimistic
      ? { ...state.optimistic, id: event.data.user_message_id } : null }
    case 'status': return { ...state, stage: event.data.stage }
    case 'delta': return { ...state, streamText: state.streamText + event.data.text }
    case 'failed': return { ...state, stage: null }
    case 'done': {
      if (!state.session) return state
      const messages = [...state.session.messages]
      if (state.optimistic && !messages.some((m) => m.id === state.optimistic?.id)) {
        messages.push({ ...state.optimistic, status: 'complete' })
      }
      if (!messages.some((m) => m.id === event.data.message.id)) messages.push({ ...event.data.message, status: 'complete' })
      return { ...state, optimistic: null, streamText: '', stage: null,
        session: { ...state.session, messages, last_turn: { turn_id: event.data.turn_id, status: 'complete', outcome: event.data.outcome } } }
    }
  }
}
