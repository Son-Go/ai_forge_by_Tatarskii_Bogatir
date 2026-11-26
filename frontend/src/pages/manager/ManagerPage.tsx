import { useState, useSyncExternalStore } from 'react'
import { caseStatuses, handoffReasons, type CaseStatus, type HandoffCase } from '../../entities/handoff/types'
import { OfferCard } from '../../entities/offer/OfferCard'
import { SourcesList } from '../../entities/source/SourcesList'
import { demoCaseStore } from '../../features/handoff/demoStore'
import { formatDate } from '../../shared/lib/presentation'
import { Icon } from '../../shared/ui/Icon'

function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`case-status case-status-${status}`}><span />{caseStatuses[status]}</span>
}

function CaseDetail({ record }: { record: HandoffCase }) {
  return <article className="case-detail" key={record.id} aria-label={`Обращение ${record.id}`}>
    <header className="case-heading"><div><a className="back-to-queue" href="#/manager"><Icon name="back" />К очереди</a><span className="eyebrow">{record.id} · веб-чат · демо</span><h2>{record.title}</h2>
      <p><Icon name="clock" /><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time><span>Контекст на момент передачи</span></p></div><StatusBadge status={record.status} /></header>
    <section className="escalation-reason"><span className="reason-icon"><Icon name="user" /></span><div><h3>{handoffReasons[record.reason]}</h3><p>{record.explanation}</p></div></section>
    <section className="case-section" aria-labelledby="requirements-heading"><div className="case-section-title"><h3 id="requirements-heading">Контекст и требования</h3><span>С указанием основания</span></div>
      <dl className="requirements-grid">{record.requirements.map((item, index) => <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd className={item.value === null ? 'unconfirmed' : ''}>{item.value ?? 'Требует уточнения'}</dd><small>{item.evidence}</small></div>)}</dl>
    </section>
    <section className="case-section case-transcript" aria-labelledby="transcript-heading"><div className="case-section-title"><h3 id="transcript-heading">История диалога</h3><span>Сообщений: {record.messages.length}</span></div>
      {record.messages.map((message) => <article className={`message message-${message.role}`} key={message.id} aria-label={message.role === 'user' ? 'Клиент' : 'ИИ-консультант'}>
        <span className="message-avatar"><Icon name={message.role === 'user' ? 'user' : 'assistant'} /></span><div className="message-content"><div className="message-author">{message.role === 'user' ? 'Клиент' : 'Консультант Softline'}<time dateTime={message.created_at}>{formatDate(message.created_at)}</time></div>
        <p className="message-body">{message.text}</p>{message.status === 'partial' && <p className="partial">Ответ прерван. Сохранена часть.</p>}</div>
      </article>)}
      {!record.messages.length && <p className="muted">Сообщений нет.</p>}
    </section>
    <section className="case-section" aria-label="Рассмотренные предложения"><div className="case-section-title"><h3>Рассмотренные предложения</h3><span>{record.offers.length}</span></div>
      {record.offers.length ? <div className="offer-grid">{record.offers.map((offer) => <OfferCard key={`${offer.offer_id}:${offer.catalog_version}`} offer={offer} sources={record.sources} readOnly />)}</div> : <p className="muted">Конкретные позиции ещё не были предложены.</p>}
      <SourcesList sources={record.sources} />
    </section>
    <section className="case-section case-documents"><Icon name="file" /><div><h3>Коммерческие документы</h3><p>Черновик КП доступен клиенту после выбора, если функция включена на сервере. Счёт не подключён: необходим отдельный контракт Backend.</p></div></section>
    <p className="manager-footnote"><Icon name="shield" />Демонстрационные данные. Отправка ответа, назначение сотрудника и CRM не подключены.</p>
  </article>
}

function DemoManager({ caseId }: { caseId: string | null }) {
  const cases = useSyncExternalStore(demoCaseStore.subscribe, demoCaseStore.getSnapshot)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | CaseStatus>('all')
  const selected = cases.find((record) => record.id === caseId)
  const visible = cases.filter((record) => (filter === 'all' || record.status === filter)
    && `${record.id} ${record.title} ${handoffReasons[record.reason]}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  return <main className={`main manager-main${caseId ? ' has-open-case' : ''}`} id="manager-workspace" tabIndex={-1}>
    <div className="workspace-bar"><div className="workspace-title"><span className="workspace-icon"><Icon name="inbox" /></span><div><h1>Рабочее пространство</h1></div></div><span className="connection-badge"><span />Локальное демо</span></div>
    <div className="manager-layout">
      <aside className="case-queue" aria-label="Очередь обращений"><div className="queue-heading"><h2>Обращения</h2><span>{cases.length}</span></div>
        <label className="queue-search"><Icon name="search" /><span className="sr-only">Поиск обращений</span><input type="search" placeholder="Номер, продукт или причина" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="queue-filters" role="group" aria-label="Статус обращения">{([['all', 'Все'], ['waiting', 'Ожидают'], ['in_progress', 'В работе']] as const).map(([value, title]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{title}</button>)}</div>
        <p className="sr-only" role="status">Найдено обращений: {visible.length}</p>
        <nav className="case-list" aria-label="Список обращений">{visible.map((record) => <a className={`case-item${record.id === caseId ? ' is-active' : ''}`} href={`#/manager/${record.id}`} key={record.id} aria-current={record.id === caseId ? 'page' : undefined}>
          <span className="case-item-meta"><span>{record.id}</span><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time></span>
          <strong>{record.title}</strong><span className="case-item-reason"><Icon name={record.reason === 'documents' ? 'file' : 'user'} />{handoffReasons[record.reason]}</span><StatusBadge status={record.status} />
        </a>)}</nav>
        {!visible.length && <div className="queue-empty"><Icon name="search" /><p>Обращений не найдено</p><button type="button" onClick={() => { setQuery(''); setFilter('all') }}>Сбросить фильтры</button></div>}
        <p className="queue-disclaimer"><Icon name="shield" />Синтетические примеры и локальные демопередачи. Реальной очереди Backend нет.</p>
      </aside>
      <div className="case-content" key={caseId || 'empty'}>{selected ? <CaseDetail record={selected} /> : <section className="manager-empty"><span className="empty-icon"><Icon name="inbox" /></span><h2>{caseId ? 'Обращение не найдено' : 'Выберите обращение'}</h2><p>{caseId ? 'Демообращение недоступно в этом браузере. Вернитесь к локальной очереди.' : 'Выберите обращение слева. История диалога, требования и рассмотренные предложения уже собраны в одном месте.'}</p>
        {caseId ? <a className="text-action" href="#/manager">Вернуться к очереди<Icon name="back" /></a> : <div className="empty-features"><span><Icon name="chat" />Полная история</span><span><Icon name="layers" />Существенные параметры</span><span><Icon name="book" />Источники и предложения</span></div>}
        <small>Демонстрационный раздел · без подключения к реальным обращениям</small>
      </section>}</div>
    </div>
  </main>
}

export function ManagerPage({ caseId, demo }: { caseId: string | null; demo: boolean }) {
  if (demo) return <DemoManager caseId={caseId} />
  return <main className="main manager-main" id="manager-workspace" tabIndex={-1}><section className="manager-empty"><span className="empty-icon"><Icon name="shield" /></span><h1>Очередь ещё не подключена</h1><p>Для реальных обращений нужны серверная очередь и отдельная авторизация менеджера. Текущий публичный API предоставляет только клиентскую сессию.</p><a className="text-action" href="#/chat">Вернуться к консультанту<Icon name="arrow" /></a></section></main>
}
