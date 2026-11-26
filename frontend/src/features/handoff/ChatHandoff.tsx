import { useState, useSyncExternalStore } from 'react'
import { handoffReasons, type HandoffReason } from '../../entities/handoff/types'
import type { Session } from '../../shared/api/types'
import { Icon } from '../../shared/ui/Icon'
import { demoCaseStore } from './demoStore'

function DemoHandoff({ session, disabled }: { session: Session; disabled: boolean }) {
  const cases = useSyncExternalStore(demoCaseStore.subscribe, demoCaseStore.getSnapshot)
  const registered = cases.find((record) => record.sessionId === session.session_id)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<HandoffReason>('complex')
  if (registered) return <section className="handoff-confirmation" role="status">
    <Icon name="check" /><div><strong>Демообращение {registered.id} зарегистрировано</strong>
    <p>Контекст доступен в локальной очереди. Реальному сотруднику ничего не отправлялось.</p>
    {!demoCaseStore.isPersistent(registered.id) && <p>Хранилище недоступно: обращение сохранено только до перезагрузки этой вкладки.</p>}
    <a href={`#/manager/${registered.id}`}>Открыть в разделе менеджера<Icon name="arrow" /></a></div>
  </section>
  return <section className="handoff" aria-label="Помощь специалиста">
    <button type="button" className="quiet-action" disabled={disabled} aria-expanded={open} aria-controls="handoff-form" onClick={() => setOpen(!open)}><Icon name="user" />Нужна помощь специалиста?<Icon name="down" /></button>
    {open && <form id="handoff-form" className="handoff-form" onSubmit={(event) => {
      event.preventDefault()
      if (!disabled) demoCaseStore.register(session, reason)
    }}><h2>Передать контекст менеджеру</h2><p>Локальная демонстрация: сохраним причину, историю, предложения и источники. Внешней отправки нет.</p>
      <label htmlFor="handoff-reason">Что нужно проверить</label>
      <select id="handoff-reason" value={reason} onChange={(event) => setReason(event.target.value as HandoffReason)}>{Object.entries(handoffReasons).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <button className="accent-action" type="submit" disabled={disabled}><Icon name="inbox" />Зарегистрировать демообращение</button>
    </form>}
  </section>
}

export function ChatHandoff({ session, demo, disabled }: { session: Session; demo: boolean; disabled: boolean }) {
  if (demo) return <DemoHandoff session={session} disabled={disabled} />
  return <details className="handoff unavailable-handoff"><summary><Icon name="user" />Нужна помощь специалиста?</summary>
    <p>Передача обращения из этого чата пока не подключена. Обращение менеджеру не зарегистрировано.</p>
    <a href="https://store.softline.ru/" target="_blank" rel="noopener noreferrer">Перейти в Store для связи со специалистом<Icon name="external" /></a>
  </details>
}
