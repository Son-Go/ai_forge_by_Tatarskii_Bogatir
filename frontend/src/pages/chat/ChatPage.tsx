import { useEffect, useRef, useState } from 'react'
import { OfferCard } from '../../entities/offer/OfferCard'
import { SourcesList } from '../../entities/source/SourcesList'
import { useChat } from '../../features/chat/model/useChat'
import { MessageComposer } from '../../features/chat/ui/MessageComposer'
import { TurnStatus } from '../../features/chat/ui/TurnStatus'
import type { ChatController } from '../../features/chat/model/ChatController'
import type { ChatState } from '../../features/chat/model/chatReducer'
import type { Message } from '../../shared/api/types'
import { Icon } from '../../shared/ui/Icon'
import { DemoBanner, WorkspaceHeader } from '../../shared/ui/WorkspaceHeader'
import { AutomaticHandoffNotice, type AutomaticHandoffNoticeData } from '../../features/chat/ui/AutomaticHandoffNotice'
import { useSessionHandoff } from '../../features/handoff/useSessionHandoff'
import { QuoteDraftAction } from '../../features/quote/QuoteDraftAction'
import { formatDate, formatPrice } from '../../shared/lib/presentation'

const exampleQuestions = [
  'Какая лицензия MDaemon подойдёт для 50 пользователей?',
  'Как защитить почту и файлы 50 сотрудников?',
  'Какие документы нужны для покупки лицензии?',
] as const
const stages = { interpreting: 'Анализируем запрос', searching: 'Ищем в каталоге и базе знаний', generating: 'Готовим ответ' }
const composerExamples = [
  'Есть MDaemon?', 'Как оформить КП?', 'Можно продлить ПО?', 'Как оплатить заказ?',
  'Есть ПО для Linux?', 'Как защитить почту?', 'Есть аналоги Visio?', 'Есть скидки на ПО?',
]
const exampleKey = 'softline:last-question-example'

function pickExample(previous?: string | null) {
  const choices = composerExamples.filter((example) => example !== previous)
  return choices[Math.floor(Math.random() * choices.length)]!
}

export function ChatView({ state, controller, mock = false, embedded = false, automaticHandoff, handoffIssue, handoffOpen = false }: { state: ChatState; controller: ChatController; mock?: boolean; embedded?: boolean; automaticHandoff?: AutomaticHandoffNoticeData; handoffIssue?: string; handoffOpen?: boolean }) {
  const [placeholder, setPlaceholder] = useState(() => {
    try { return pickExample(sessionStorage.getItem(exampleKey)) } catch { return pickExample() }
  })
  const [following, setFollowing] = useState(true)
  const [atEnd, setAtEnd] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const busy = state.phase !== 'ready' || state.issue?.action === 'resend'
  const canSwitch = state.phase === 'ready' || state.phase === 'unavailable'
  const messages: Message[] = [...state.session?.messages || []]
  if (state.optimistic && !messages.some((m) => m.id === state.optimistic?.id)) messages.push(state.optimistic)
  const hasMessages = messages.length > 0
  const signature = `${messages.length}:${state.streamText.length}:${state.phase}:${automaticHandoff?.title || ''}:${automaticHandoff?.message || ''}`
  useEffect(() => {
    try { sessionStorage.setItem(exampleKey, placeholder) } catch { /* Storage may be disabled. */ }
  }, [placeholder])
  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [signature, following])
  useEffect(() => {
    const root = viewport.current
    const target = end.current
    if (!root || !target || typeof IntersectionObserver === 'undefined') return
    // Observe actual content visibility across streaming, resize and section switches.
    // This controls only the navigation affordance; auto-follow keeps its existing policy.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setAtEnd(root.clientHeight === 0 || entry.isIntersecting)
    }, { root, threshold: 1 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  function startNewDialog() {
    setPlaceholder(pickExample(placeholder))
    setFollowing(true)
    void controller.newSession()
  }
  function goHome() {
    setPlaceholder(pickExample(placeholder))
    setFollowing(true)
    controller.goHome()
    viewport.current?.closest('main')?.focus({ preventScroll: true })
  }
  const selected = state.session?.selected_offer
  const selectedInHistory = selected && messages.some((message) => message.cards.some((offer) =>
    selected.offer_id === offer.offer_id && selected.catalog_version === offer.catalog_version))
  function messageNode(message: Message) {
    return <article className={`message message-${message.role}`} key={message.id} aria-label={message.role === 'user' ? 'Вы' : message.sender === 'manager' ? 'Специалист' : 'Консультант'}>
      <span className="message-avatar" aria-hidden="true"><Icon name={message.role === 'user' ? 'user' : 'assistant'} /></span>
      <div className="message-content">
      <div className="message-author">{message.role === 'user' ? 'Вы' : message.sender === 'manager' ? 'Специалист Softline' : 'Консультант Softline'}{message.role === 'assistant' && message.sender !== 'manager' && <span className="ai-tag">AI</span>}</div>
      <div className="message-body">{message.text}</div>
      {message.status === 'partial' && <p className="partial"><Icon name="warning" />Ответ прерван. Показана сохранённая часть.</p>}
      {message.status === 'streaming' && <p className="muted">Сохранённая часть ответа</p>}
      {!!message.cards.length && <div className="offer-grid">{message.cards.map((offer) => <OfferCard key={`${offer.offer_id}:${offer.catalog_version}`} offer={offer}
        sources={message.sources} disabled={!!busy} onSelect={(card) => void controller.select(card)}
        selected={selected?.offer_id === offer.offer_id && selected.catalog_version === offer.catalog_version} />)}</div>}
      <SourcesList sources={message.sources} />
      </div>
    </article>
  }
  let status = ''
  if (state.phase === 'booting') status = 'Загружаем диалог…'
  if (state.phase === 'sending') status = 'Отправляем сообщение…'
  if (state.phase === 'streaming') status = state.stage ? stages[state.stage] : 'Ожидаем ответа модели…'
  if (state.phase === 'recovering' && !state.issue) status = 'Восстанавливаем сохранённый диалог…'
  if (state.phase === 'selecting') status = 'Подтверждаем выбранное предложение…'
  return <div className={embedded ? 'chat-section' : 'app-shell'}>
    {!embedded && <><WorkspaceHeader />{mock && <DemoBanner />}</>}
    <main className={`main${hasMessages ? ' has-messages' : ''}`} id="consultant-workspace" tabIndex={-1}>
      <div className="workspace-bar">
        <div className="workspace-title">
          {hasMessages ? <button className="chat-back" type="button" aria-label="На главную" title="На главную" disabled={!canSwitch} onClick={goHome}><Icon name="back" /></button>
            : <span className="workspace-icon"><Icon name="assistant" /></span>}
          <h1>Консультант Softline</h1>
        </div>
        <div className="workspace-actions"><button className="new-dialog" type="button" aria-label="Новый диалог" title="Новый диалог" disabled={!canSwitch} onClick={startNewDialog}><Icon name="plus" /><span>Новый диалог</span></button></div>
      </div>
      <div className="conversation" ref={viewport} onScroll={() => {
        const el = viewport.current
        if (el) {
          const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
          setFollowing(remaining < 80)
          setAtEnd(remaining <= 2)
        }
      }} aria-label="Переписка">
        {!messages.length && state.phase === 'ready' && <section className="welcome">
          <h2>Поможем найти <span>подходящее решение</span></h2>
          <p>Подберём ПО из каталога Softline и уточним условия лицензии.</p>
          <h3 id="example-questions-heading">Примеры вопросов</h3>
          <ul className="example-questions" aria-labelledby="example-questions-heading">
            {exampleQuestions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        </section>}
        {messages.map(messageNode)}
        {state.streamText && <article className="message message-assistant" aria-label="Ответ формируется"><span className="message-avatar" aria-hidden="true"><Icon name="assistant" /></span><div className="message-content"><div className="message-author">Консультант Softline<span className="ai-tag">AI</span></div><div className="message-body">{state.streamText}</div></div></article>}
        <TurnStatus key={`${state.phase}:${state.stage}`} text={status} interpreting={state.phase === 'streaming' && state.stage === 'interpreting'} />
        {state.issue && <section className="notice" role="alert"><Icon name="warning" /><div className="notice-content"><p>{state.issue.message}</p>
          {state.issue.requestId && <small>Код запроса: {state.issue.requestId}</small>}
          {state.issue.action === 'restore' && <button type="button" onClick={() => void controller.recover()}>Проверить состояние</button>}
          {state.issue.action === 'new-session' && <button type="button" onClick={startNewDialog}>Начать новый диалог</button>}
          {['retry', 'resend'].includes(state.issue.action || '') && <button type="button" disabled={state.phase !== 'ready'} onClick={() => void controller.repeat()}>Повторить отправку</button>}
          </div>
        </section>}
        {state.updatedOffer && <section className="updated-offer"><h2>Обновлённое предложение</h2><OfferCard offer={state.updatedOffer} selected={false} disabled={!!busy} onSelect={(card) => void controller.select(card)} /></section>}
        {selected && !selectedInHistory && <section className="updated-offer"><h2>Выбранное предложение</h2><OfferCard offer={selected} selected disabled={!!busy} onSelect={(card) => void controller.select(card)} /></section>}
        {state.session?.price_terms && <section className="sales-terms" aria-label="Условия предложения">
          <h2>Условия предложения</h2><p className="muted">За единицу выбранной позиции. Суммы подтверждены сервером.</p>
          <dl><div><dt>Базовая цена</dt><dd>{formatPrice({ amount: state.session.price_terms.base_amount, currency: state.session.price_terms.currency })}</dd></div>
            <div><dt>Скидка</dt><dd>{state.session.price_terms.discount_percent}%</dd></div>
            <div><dt>Итого за единицу</dt><dd>{formatPrice({ amount: state.session.price_terms.final_amount, currency: state.session.price_terms.currency })}</dd></div></dl>
        </section>}
        {state.session && messages.length > 0 && state.session.quotes_enabled && selected && !busy && <div className="conversation-actions">
          <QuoteDraftAction key={`${state.session.session_id}:${selected.offer_id}:${selected.catalog_version}:${state.session.last_turn?.turn_id}`} sessionId={state.session.session_id} demo={mock} onRefresh={() => void controller.recover()} onOfferChanged={controller.showUpdatedOffer} />
        </div>}
        {state.session?.support_topic && !busy && !handoffOpen && <div className="conversation-actions">
          <button type="button" className="quiet-action" onClick={() => { setFollowing(true); void controller.send('Не помогло') }}>Не помогло</button>
        </div>}
        <AutomaticHandoffNotice notice={automaticHandoff} />
        {handoffIssue && <p className="handoff-sync-issue muted" role="status">{handoffIssue}</p>}
        <div className="conversation-end" ref={end} aria-hidden="true" />
      </div>
      {messages.length > 0 && !atEnd && <div className="conversation-jump"><button type="button" className="latest" aria-label="К последнему сообщению" title="К последнему сообщению" onClick={() => {
        if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
        setFollowing(true)
      }}><Icon name="down" /></button></div>}
      <div className="composer-dock">
      <MessageComposer key={state.composerKey} disabled={!!busy} placeholder={placeholder} onSend={async (text) => { setFollowing(true); await controller.send(text); return controller.getSnapshot().rejectedText }} />
      <p className="footnote"><Icon name="shield" />Параметры, стоимость и наличие требуют проверки по источникам.</p>
      </div>
    </main>
    {!hasMessages && (state.recentDialogs.length > 0 || state.recentIssue) && <section className="recent-dialogs" aria-labelledby="recent-dialogs-heading">
      <h2 className="recent-dialog-heading" id="recent-dialogs-heading"><Icon name="clock" />Недавние диалоги</h2>
      {state.recentIssue && <p className="recent-dialog-issue" role="alert">{state.recentIssue}</p>}
      {state.recentDialogs.length > 0 && <ul className="recent-dialog-list" role="list">
        {state.recentDialogs.map((dialog) => {
          const active = state.session?.session_id === dialog.id
          return <li key={dialog.id}><button className="recent-dialog" type="button" aria-current={active || undefined} disabled={!canSwitch || active} onClick={() => {
            setFollowing(true)
            void controller.openSession(dialog.id)
          }}><span>{dialog.title}</span><time dateTime={dialog.updatedAt}>{formatDate(dialog.updatedAt)}</time></button></li>
        })}
      </ul>}
    </section>}
  </div>
}

export function ChatPage({ embedded = false }: { embedded?: boolean }) {
  const { state, controller } = useChat()
  const { handoff, issue } = useSessionHandoff(state, controller)
  const notice = handoff ? {
    title: handoff.status === 'resolved' ? 'Обращение завершено' : 'Обращение передано специалисту',
    message: handoff.status === 'resolved' ? 'Вы можете продолжить диалог с ИИ-консультантом.' : handoff.status === 'queued' ? 'Ожидаем специалиста. Вы можете добавить уточнения в этот диалог.' : 'Специалист работает с обращением. Продолжайте переписку здесь.',
    caseReference: handoff.handoff_id,
  } : undefined
  return <ChatView state={state} controller={controller} mock={import.meta.env.MODE === 'mock'} embedded={embedded} automaticHandoff={notice} handoffIssue={issue} handoffOpen={!!handoff && handoff.status !== 'resolved'} />
}
