import type { Message } from '../../shared/api/types'
import { formatDate } from '../../shared/lib/presentation'
import { Icon } from '../../shared/ui/Icon'

// The available data contains correspondence only. Do not manufacture manager
// actions, status transitions, document records or timestamps from current status.
export function CaseTimeline({ messages }: { messages: readonly Message[] }) {
  const entries = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  if (!entries.length) return <p className="muted">История пока пуста.</p>
  return <ol className="case-timeline" aria-label="Хронология обращения">
    {entries.map((message) => <li key={message.id} className="timeline-message">
      <article className={`message message-${message.role}`} aria-label={message.role === 'user' ? 'Клиент' : message.sender === 'manager' ? 'Специалист' : 'ИИ-консультант'}>
        <span className="message-avatar" aria-hidden="true"><Icon name={message.role === 'user' ? 'user' : 'assistant'} /></span>
        <div className="message-content"><div className="message-author">{message.role === 'user' ? 'Клиент' : message.sender === 'manager' ? 'Специалист Softline' : 'Консультант Softline'}<time dateTime={message.created_at}>{formatDate(message.created_at)}</time></div>
          <p className="message-body">{message.text}</p>{message.status === 'partial' && <p className="partial">Ответ прерван. Сохранена часть.</p>}
        </div>
      </article>
    </li>)}
  </ol>
}
