import type { Source } from '../../shared/api/types'
import { formatDate, safeUrl } from '../../shared/lib/presentation'
import { Icon } from '../../shared/ui/Icon'

export function SourcesList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null
  return <details className="sources" open><summary><Icon name="book" /><span>Источники ответа</span><span className="source-count">{sources.length}</span><Icon name="down" /></summary><ul>
    {sources.map((source) => {
      const url = safeUrl(source.url)
      return <li key={source.id}><span className="source-file-icon"><Icon name="book" /></span><div className="source-content">{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}<Icon name="external" /></a> : <span>{source.title}</span>}
        <div className="source-meta"><small className="source-kind">{({ catalog: 'Каталог', store: 'Карточка Store', knowledge: 'База знаний' })[source.kind]}</small>
        {source.snapshot_at && <small>Снимок: {formatDate(source.snapshot_at)}</small>}
        {source.checked_at && <small>Проверено: {formatDate(source.checked_at)}</small>}
        </div></div></li>
    })}
  </ul></details>
}
