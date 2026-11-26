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
import { InvoiceDemo } from '../../features/quote/InvoiceDemo'
import { QuoteDraftAction } from '../../features/quote/QuoteDraftAction'

const suggestions = [
  { title: 'Знаю продукт', description: 'Найдём нужную версию и уточним условия лицензии.', icon: 'search', text: 'Нужна новая лицензия MDaemon. Помогите выбрать вариант.' },
  { title: 'Подобрать решение', description: 'Сопоставим вашу задачу с предложениями каталога.', icon: 'layers', text: 'Нужно защитить почту и файлы на 50 сотрудников.' },
  { title: 'Задать вопрос', description: 'Разберёмся в характеристиках и условиях покупки.', icon: 'book', text: 'Какие документы нужны для покупки лицензии?' },
] as const
const stages = { interpreting: 'Анализируем запрос', searching: 'Ищем в каталоге и базе знаний', generating: 'Готовим ответ' }

export function ChatView({ state, controller, mock = false, embedded = false, automaticHandoff, handoffIssue }: { state: ChatState; controller: ChatController; mock?: boolean; embedded?: boolean; automaticHandoff?: AutomaticHandoffNoticeData; handoffIssue?: string }) {
  const [suggestion, setSuggestion] = useState('')
  const [following, setFollowing] = useState(true)
  const [atEnd, setAtEnd] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const busy = state.phase !== 'ready' || state.issue?.action === 'resend'
  const messages: Message[] = [...state.session?.messages || []]
  if (state.optimistic && !messages.some((m) => m.id === state.optimistic?.id)) messages.push(state.optimistic)
  const signature = `${messages.length}:${state.streamText.length}:${state.phase}:${automaticHandoff?.title || ''}:${automaticHandoff?.message || ''}`
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
  function fill(text: string) { setSuggestion(text); document.getElementById('message')?.focus() }
  const selected = state.session?.selected_offer
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
    <main className={`main${messages.length ? ' has-messages' : ''}`} id="consultant-workspace" tabIndex={-1}>
      <div className="workspace-bar"><div className="workspace-title"><span className="workspace-icon"><Icon name="assistant" /></span><h1>Консультант Softline</h1></div><div className="workspace-actions"><button className="new-dialog" type="button" disabled={!['ready', 'unavailable'].includes(state.phase)} onClick={() => { setSuggestion(''); void controller.newSession() }}><Icon name="plus" />Новый диалог</button></div></div>
      <div className="conversation" ref={viewport} onScroll={() => {
        const el = viewport.current
        if (el) {
          const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
          setFollowing(remaining < 80)
          setAtEnd(remaining <= 2)
        }
      }} aria-label="Переписка">
        {!messages.length && state.phase === 'ready' && <section className="welcome">
          <div className="welcome-intro"><div className="welcome-copy"><span className="eyebrow"><span />От задачи — к выбору</span>
          <h2>Поможем найти<br /><span>подходящее решение</span></h2><p>Программное обеспечение для ваших задач. Уточним требования, подберём варианты и ответим на вопросы с опорой на источники.</p></div>
          <aside className="welcome-guide" aria-label="Как помогает консультант"><span className="guide-heading">Продуманный выбор</span>
            <div><Icon name="search" /><p><strong>Уточняем главное</strong><span>Задача, инфраструктура и условия лицензии</span></p></div>
            <div><Icon name="layers" /><p><strong>Сопоставляем варианты</strong><span>Предложения из каталога Softline</span></p></div>
            <div><Icon name="book" /><p><strong>Показываем основания</strong><span>Характеристики и ссылки на источники</span></p></div>
          </aside></div>
          <div className="scenario-heading"><h3>С чего начнём?</h3><span>Выберите сценарий или напишите свой вопрос</span></div>
          <div className="suggestions">{suggestions.map((item, index) => <button className="scenario-card" type="button" key={item.title} aria-label={item.title} aria-describedby={`scenario-${index}`} onClick={() => fill(item.text)}><span className="scenario-top"><span className="scenario-icon"><Icon name={item.icon} /></span><span className="scenario-number">0{index + 1}</span></span><strong>{item.title}</strong><span className="scenario-description" id={`scenario-${index}`}>{item.description}</span><span className="scenario-action">Начать консультацию<Icon name="arrow" /></span></button>)}</div>
        </section>}
        {messages.map(messageNode)}
        {state.streamText && <article className="message message-assistant" aria-label="Ответ формируется"><span className="message-avatar" aria-hidden="true"><Icon name="assistant" /></span><div className="message-content"><div className="message-author">Консультант Softline<span className="ai-tag">AI</span></div><div className="message-body">{state.streamText}</div></div></article>}
        <TurnStatus key={`${state.phase}:${state.stage}`} text={status} interpreting={state.phase === 'streaming' && state.stage === 'interpreting'} />
        {state.issue && <section className="notice" role="alert"><Icon name="warning" /><div className="notice-content"><p>{state.issue.message}</p>
          {state.issue.requestId && <small>Код запроса: {state.issue.requestId}</small>}
          {state.issue.action === 'restore' && <button type="button" onClick={() => void controller.recover()}>Проверить состояние</button>}
          {state.issue.action === 'new-session' && <button type="button" onClick={() => void controller.newSession()}>Начать новый диалог</button>}
          {['retry', 'resend'].includes(state.issue.action || '') && <button type="button" disabled={state.phase !== 'ready'} onClick={() => void controller.repeat()}>Повторить отправку</button>}
          </div>
        </section>}
        {state.updatedOffer && <section className="updated-offer"><h2>Обновлённое предложение</h2><OfferCard offer={state.updatedOffer} selected={false} disabled={!!busy} onSelect={(card) => void controller.select(card)} /></section>}
        {state.session && messages.length > 0 && state.session.quotes_enabled && selected && !busy && <div className="conversation-actions">
          {state.session.quotes_enabled && selected && !busy && <QuoteDraftAction key={`${state.session.session_id}:${selected.offer_id}:${selected.catalog_version}:${state.session.last_turn?.turn_id}`} sessionId={state.session.session_id} demo={mock} onRefresh={() => void controller.recover()} />}
        </div>}
        {mock && selected && !busy && <div className="conversation-actions"><InvoiceDemo /></div>}
        <AutomaticHandoffNotice notice={automaticHandoff} />
        {handoffIssue && <p className="handoff-sync-issue muted" role="status">{handoffIssue}</p>}
        <div className="conversation-end" ref={end} aria-hidden="true" />
      </div>
      {messages.length > 0 && !atEnd && <div className="conversation-jump"><button type="button" className="latest" aria-label="К последнему сообщению" title="К последнему сообщению" onClick={() => {
        if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
        setFollowing(true)
      }}><Icon name="down" /></button></div>}
      <div className="composer-dock">
      <MessageComposer disabled={!!busy} suggestion={suggestion} onEdited={() => setSuggestion('')} onSend={async (text) => { setFollowing(true); await controller.send(text); return controller.getSnapshot().rejectedText }} />
      <p className="footnote"><Icon name="shield" />Параметры, стоимость и наличие требуют проверки по источникам.</p>
      </div>
    </main>
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
  return <ChatView state={state} controller={controller} mock={import.meta.env.MODE === 'mock'} embedded={embedded} automaticHandoff={notice} handoffIssue={issue} />
}
