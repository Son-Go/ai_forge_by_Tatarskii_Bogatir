// Development test entry only. Not imported by the app or the production build.
// These are display props and simulated callbacks, not mock API DTOs or routes.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FaqReviewPanel, type FaqReviewStatus } from '../../src/features/faq/FaqReviewPanel'
import type { Source } from '../../src/shared/api/types'
import '../../src/app/styles/global.css'
import '../../src/app/styles/workspace.css'

const source: Source = { id: 'synthetic-reference', title: 'Синтетический источник для проверки интерфейса', kind: 'knowledge', url: 'https://example.com/support/faq', checked_at: '2026-11-27T10:00:00Z' }
const labels: FaqReviewStatus[] = ['В очереди', 'В FAQ', 'Нужна проверка', 'Ответ по заказу', 'Отклонено']
export function Fixture() {
  const [status, setStatus] = useState<FaqReviewStatus>('Нужна проверка')
  const [question, setQuestion] = useState('Где узнать общие условия покупки?')
  const [answer, setAnswer] = useState('Посмотрите условия покупки в справке. Условия конкретного заказа требуют отдельного подтверждения.')
  const [dark, setDark] = useState(true)
  const [failNext, setFailNext] = useState(false)
  const [operations, setOperations] = useState(0)
  async function simulate(signal: AbortSignal) {
    setOperations((count) => count + 1)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 400)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled fixture action')) }, { once: true })
    })
    if (signal.aborted) return false
    if (failNext) { setFailNext(false); throw new Error('Тестовый сетевой сбой') }
    return true
  }
  return <main style={{ maxWidth: 820, margin: '24px auto', padding: 16 }}>
    <p>Изолированная UI-проверка · только синтетические данные · без API</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0' }}>
      <label>Состояние UI <select value={status} onChange={(event) => setStatus(event.target.value as FaqReviewStatus)}>{labels.map((label) => <option key={label}>{label}</option>)}</select></label>
      <button type="button" onClick={() => { document.documentElement.dataset.theme = dark ? 'light' : 'dark'; setDark(!dark) }}>Сменить тему</button>
      <label><input type="checkbox" checked={failNext} onChange={(event) => setFailNext(event.target.checked)} />Следующее действие завершится ошибкой</label>
    </div>
    <p>Вызовов тестового обработчика: <output data-testid="operations">{operations}</output></p>
    <FaqReviewPanel status={status} question={question} answer={answer} source={source}
      reason={status === 'Нужна проверка' ? 'Тестовая причина: уточните формулировку и подтвердите источник.' : undefined}
      onPublish={async (q, a, _source, signal) => { if (await simulate(signal)) { setQuestion(q); setAnswer(a); setStatus('В FAQ') } }}
      onReject={async (signal) => { if (await simulate(signal)) setStatus('Отклонено') }}
      onUnpublish={async (signal) => { if (await simulate(signal)) setStatus('Нужна проверка') }} />
  </main>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
