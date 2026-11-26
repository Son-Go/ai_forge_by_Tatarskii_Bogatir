import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ChatPage } from '../pages/chat/ChatPage'

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
export function App() { return <ErrorBoundary><ChatPage /></ErrorBoundary> }
