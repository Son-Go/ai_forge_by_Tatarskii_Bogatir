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

const suggestions = [
  { title: 'Знаю продукт', description: 'Найдём нужную версию и уточним условия лицензии.', icon: 'search', text: 'Нужна новая лицензия MDaemon. Помогите выбрать вариант.' },
  { title: 'Подобрать решение', description: 'Сопоставим вашу задачу с предложениями каталога.', icon: 'layers', text: 'Нужно защитить почту и файлы на 50 сотрудников.' },
  { title: 'Задать вопрос', description: 'Разберёмся в характеристиках и условиях покупки.', icon: 'book', text: 'Какие документы нужны для покупки лицензии?' },
] as const
const stages = { interpreting: 'Анализируем запрос', searching: 'Ищем в каталоге и базе знаний', generating: 'Готовим ответ' }

export function ChatView({ state, controller, mock = false }: { state: ChatState; controller: ChatController; mock?: boolean }) {
  const [suggestion, setSuggestion] = useState('')
  const [following, setFollowing] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const busy = state.phase !== 'ready' || state.issue?.action === 'resend'
  const messages: Message[] = [...state.session?.messages || []]
  if (state.optimistic && !messages.some((m) => m.id === state.optimistic?.id)) messages.push(state.optimistic)
  const signature = `${messages.length}:${state.streamText.length}:${state.phase}`
  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [signature, following])
  function fill(text: string) { setSuggestion(text); document.getElementById('message')?.focus() }
  const selected = state.session?.selected_offer
  function messageNode(message: Message) {
    return <article className={`message message-${message.role}`} key={message.id} aria-label={message.role === 'user' ? 'Вы' : 'Консультант'}>
      <span className="message-avatar" aria-hidden="true"><Icon name={message.role === 'user' ? 'user' : 'assistant'} /></span>
      <div className="message-content">
      <div className="message-author">{message.role === 'user' ? 'Вы' : 'Консультант Softline'}{message.role === 'assistant' && <span className="ai-tag">AI</span>}</div>
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
  return <div className="app-shell">
    <a className="skip-link" href="#consultant-workspace">Перейти к консультации</a>
    <header className="header"><div className="header-inner">
      <a className="brand" href="https://store.softline.ru/" target="_blank" rel="noopener noreferrer" aria-label="Softline Store — открыть магазин">
        <span className="brand-wordmark">софт<span>лайн</span></span><span className="brand-caption">STORE</span>
      </a>
      <nav className="header-nav" aria-label="Навигация Softline"><a href="https://store.softline.ru/" target="_blank" rel="noopener noreferrer">Магазин Softline<Icon name="external" /></a><span className="nav-current" aria-current="page"><Icon name="assistant" />AI-консультант</span></nav>
      </div>
    </header>
    {mock && <aside className="mock-banner"><span className="demo-tag">ДЕМО</span>Демонстрационный режим · используются синтетические данные</aside>}
    <main className={`main${messages.length ? ' has-messages' : ''}`} id="consultant-workspace" tabIndex={-1}>
      <div className="workspace-bar"><div className="workspace-title"><span className="workspace-icon"><Icon name="assistant" /></span><h1>Консультант Softline</h1></div><div className="workspace-actions"><span className="workspace-context"><Icon name="book" />Каталог и база знаний</span><button className="new-dialog" type="button" disabled={!['ready', 'unavailable'].includes(state.phase)} onClick={() => { setSuggestion(''); void controller.newSession() }}><Icon name="plus" />Новый диалог</button></div></div>
      <div className="conversation" ref={viewport} onScroll={() => {
        const el = viewport.current
        if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
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
      </div>
      <div className="composer-dock">
      {!following && <button type="button" className="latest" onClick={() => setFollowing(true)}>К последнему сообщению<Icon name="down" /></button>}
      <MessageComposer disabled={!!busy} suggestion={suggestion} onEdited={() => setSuggestion('')} onSend={async (text) => { setFollowing(true); await controller.send(text); return controller.getSnapshot().rejectedText }} />
      <p className="footnote"><Icon name="shield" />Параметры, стоимость и наличие требуют проверки по источникам.</p>
      </div>
    </main>
  </div>
}

export function ChatPage() {
  const { state, controller } = useChat()
  return <ChatView state={state} controller={controller} mock={import.meta.env.MODE === 'mock'} />
}
