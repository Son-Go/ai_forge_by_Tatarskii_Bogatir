import { useState, type ReactNode } from 'react'
import { caseStatuses, handoffReasons, type CaseStatus, type HandoffCase } from '../../entities/handoff/types'
import { CaseTimeline } from '../../entities/handoff/CaseTimeline'
import { OfferCard } from '../../entities/offer/OfferCard'
import { SourcesList } from '../../entities/source/SourcesList'
import { formatDate } from '../../shared/lib/presentation'
import { Icon } from '../../shared/ui/Icon'

function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`case-status case-status-${status}`}><span />{caseStatuses[status]}</span>
}

export function CaseDetail({ record }: { record: HandoffCase }) {
  return <article className="case-detail" key={record.id} aria-label={`Обращение ${record.id}`}>
    <header className="case-heading"><div><a className="back-to-queue" href="#/manager"><Icon name="back" />К очереди</a><span className="eyebrow">{record.id} · веб-чат · демо</span><h2>{record.title}</h2>
      <p><Icon name="clock" /><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time><span>Доступный контекст обращения</span></p></div><StatusBadge status={record.status} /></header>
    <section className="escalation-reason"><span className="reason-icon"><Icon name="user" /></span><div><h3>{handoffReasons[record.reason]}</h3><p>{record.explanation}</p></div></section>
    <section className="case-section" aria-labelledby="requirements-heading"><div className="case-section-title"><h3 id="requirements-heading">Контекст и требования</h3><span>С указанием основания</span></div>
      <dl className="requirements-grid">{record.requirements.map((item, index) => <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd className={item.value === null ? 'unconfirmed' : ''}>{item.value ?? 'Требует уточнения'}</dd><small>{item.evidence}</small></div>)}</dl>
      {!record.requirements.length && <p className="muted">Структурированные требования не передаются этим API.</p>}
    </section>
    <section className="case-section case-transcript" aria-labelledby="transcript-heading"><div className="case-section-title"><h3 id="transcript-heading">История обращения</h3><span>Сообщений: {record.messages.length}</span></div>
      <CaseTimeline messages={record.messages} />
      <p className="timeline-note muted">Журнал действий, изменений статуса и документов не передаётся текущим API.</p>
    </section>
    <section className="case-section" aria-label="Рассмотренные предложения"><div className="case-section-title"><h3>Рассмотренные предложения</h3><span>{record.offers.length}</span></div>
      {record.offers.length ? <div className="offer-grid">{record.offers.map((offer) => <OfferCard key={`${offer.offer_id}:${offer.catalog_version}`} offer={offer} sources={record.sources} readOnly />)}</div> : <p className="muted">Конкретные позиции ещё не были предложены.</p>}
      <SourcesList sources={record.sources} />
    </section>
    <section className="case-section case-documents"><Icon name="file" /><div><h3>Коммерческие документы</h3><p>Черновик КП доступен клиенту после выбора, если функция включена на сервере. Счёт не подключён: необходим отдельный контракт Backend.</p></div></section>
    <p className="manager-footnote"><Icon name="shield" />Содержимое переписки и источников требует проверки. Управление CRM не входит в этот интерфейс.</p>
  </article>
}

export function ManagerWorkspace({ caseId, cases, demo = false, detail, controls, pagination }: {
  caseId: string | null; cases: HandoffCase[]; demo?: boolean; detail?: ReactNode; controls?: ReactNode; pagination?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | CaseStatus>('all')
  const selected = cases.find((record) => record.id === caseId)
  const visible = cases.filter((record) => (filter === 'all' || record.status === filter)
    && `${record.id} ${record.title} ${handoffReasons[record.reason]}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  return <main className={`main manager-main${caseId ? ' has-open-case' : ''}`} id="manager-workspace" tabIndex={-1}>
    <div className="workspace-bar"><div className="workspace-title"><span className="workspace-icon"><Icon name="inbox" /></span><div><h1>Рабочее пространство</h1></div></div><div className="manager-controls"><span className="connection-badge"><span />{demo ? 'Локальное демо' : 'API · менеджер'}</span>{controls}</div></div>
    <div className="manager-layout">
      <aside className="case-queue" aria-label="Очередь обращений"><div className="queue-heading"><h2>Обращения</h2><span>{cases.length}</span></div>
        <label className="queue-search"><Icon name="search" /><span className="sr-only">Поиск обращений</span><input type="search" placeholder="Номер, продукт или причина" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="queue-filters"><span className="sr-only">Статус обращения</span><select className={filter === 'all' ? '' : 'is-filtered'} aria-label="Статус обращения" value={filter} onChange={(event) => setFilter(event.target.value as 'all' | CaseStatus)}>{([['all', 'Все'], ['queued', 'Ожидают'], ['in_progress', 'В работе'], ['resolved', 'Завершённые']] as const).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select><Icon name="down" /></label>
        <p className="sr-only" role="status">Найдено в загруженных данных: {visible.length}</p>
        <nav className="case-list" aria-label="Список обращений">{visible.map((record) => <a className={`case-item${record.id === caseId ? ' is-active' : ''}`} href={`#/manager/${record.id}`} key={record.id} aria-current={record.id === caseId ? 'page' : undefined}>
          <span className="case-item-meta"><span>{record.id}</span><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time></span>
          <strong>{record.title}</strong><span className="case-item-reason"><Icon name={record.reason === 'documents' ? 'file' : 'user'} />{handoffReasons[record.reason]}</span><StatusBadge status={record.status} />
        </a>)}</nav>
        {!visible.length && <div className="queue-empty"><Icon name="search" /><p>Обращений не найдено</p><button type="button" onClick={() => { setQuery(''); setFilter('all') }}>Сбросить фильтры</button></div>}
        <p className="queue-disclaimer"><Icon name="shield" />{demo ? 'Синтетические примеры. ' : ''}Поиск и фильтры применяются только к загруженной странице.</p>
        {pagination}
      </aside>
      <div className="case-content" key={caseId || 'empty'}>{detail !== undefined ? detail : selected ? <CaseDetail record={selected} /> : <section className="manager-empty"><span className="empty-icon"><Icon name="inbox" /></span><h2>{caseId ? 'Обращение не найдено' : 'Выберите обращение'}</h2><p>{caseId ? 'Обращение недоступно в загруженной странице. Вернитесь к списку.' : 'Откройте обращение из списка слева, чтобы увидеть контекст и историю событий.'}</p>
        {caseId ? <a className="text-action" href="#/manager">Вернуться к очереди<Icon name="back" /></a> : null}
      </section>}</div>
    </div>
  </main>
}
