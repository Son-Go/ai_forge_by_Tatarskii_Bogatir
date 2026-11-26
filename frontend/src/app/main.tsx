import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

async function bootstrap() {
  if (import.meta.env.DEV && import.meta.env.MODE === 'mock') {
    const { worker } = await import('../mocks/browser')
    await worker.start({ onUnhandledFrame: 'bypass', quiet: true })
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
}
void bootstrap().catch(() => {
  const root = document.getElementById('root')!
  root.textContent = 'Не удалось запустить приложение. Проверьте настройки и перезагрузите страницу.'
})
