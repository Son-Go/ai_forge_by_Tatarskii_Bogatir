import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react'
import { ChatPage } from '../pages/chat/ChatPage'
import { ManagerPage } from '../pages/manager/ManagerPage'
import { useAppRoute } from '../shared/lib/useAppRoute'
import { DemoBanner, WorkspaceHeader } from '../shared/ui/WorkspaceHeader'

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, info: ErrorInfo) {
    // Do not log message contents or full state.
    if (import.meta.env.DEV) console.error('Ошибка интерфейса', info.componentStack)
  }
  render() {
    return this.state.failed ? <main className="fatal"><h1>Не удалось отобразить диалог</h1><p>Попробуйте перезагрузить страницу. Сохранённая история останется на сервере.</p><button onClick={() => location.reload()}>Перезагрузить</button></main> : this.props.children
  }
}
export function App() {
  const { route, chatVisited } = useAppRoute()
  const routeKey = `${route.section}:${route.caseId || ''}`
  const previousRoute = useRef(routeKey)
  useEffect(() => {
    if (previousRoute.current !== routeKey) document.getElementById(route.section === 'chat' ? 'consultant-workspace' : 'manager-workspace')?.focus({ preventScroll: true })
    previousRoute.current = routeKey
  }, [routeKey, route.section])
  const demo = import.meta.env.MODE === 'mock'
  return <ErrorBoundary><div className="app-shell">
    <WorkspaceHeader section={route.section} />
    {demo && <DemoBanner />}
    <div className="section-frame" hidden={route.section !== 'chat'}>{chatVisited && <ChatPage embedded />}</div>
    {route.section === 'manager' && <ManagerPage caseId={route.caseId} demo={demo} />}
  </div></ErrorBoundary>
}
