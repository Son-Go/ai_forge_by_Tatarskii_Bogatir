import { useEffect, useState, useSyncExternalStore } from 'react'
import { chatApi } from '../../../shared/api/chatApi'
import { browserStorage } from '../lib/sessionStorage'
import { ChatController } from './ChatController'

export function useChat() {
  const [controller] = useState(() => new ChatController(chatApi, browserStorage(import.meta.env.MODE === 'mock' ? 'mock' : 'api')))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { void controller.start(); return controller.stop }, [controller])
  return { state, controller }
}
