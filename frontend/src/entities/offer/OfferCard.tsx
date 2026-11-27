import type { Offer, Source } from '../../shared/api/types'
import { attributes, formatPrice, safeUrl } from '../../shared/lib/presentation'
import { Icon } from '../../shared/ui/Icon'

export function OfferCard({ offer, sources = [], selected = false, disabled = false, onSelect, readOnly = false }: {
  offer: Offer; sources?: Source[]; selected?: boolean; disabled?: boolean; onSelect?: (offer: Offer) => void; readOnly?: boolean
}) {
  const url = safeUrl(offer.product_url)
  // A visible price or a similar family is not a server permission to select.
  // Historical cards stay readable when that optional permission is absent.
  const selectable = offer.selectable === true
  const source = sources.find((s) => offer.source_ids.includes(s.id))
  return <article className={`offer-card${selected ? ' is-selected' : ''}`} aria-label={offer.name}>
    <div className="offer-top"><span className="offer-icon"><Icon name="package" /></span><span className="offer-eyebrow">Предложение каталога</span>{selected && <span className="selected-badge"><Icon name="check" />Выбрано</span>}</div>
    <h3>{offer.name}</h3>
    <dl>{attributes(offer).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    <div className="offer-price-block"><span className="price-label">Стоимость по каталогу</span><p className="price">{formatPrice(offer.price)}</p>
    {!offer.price && <p className="muted">Стоимость необходимо подтвердить у менеджера.</p>}
    <p className={`availability availability-${offer.availability}`}><span className="availability-dot" aria-hidden="true" />{({ available: 'Доступно по данным каталога', unavailable: 'Нет в наличии по данным фида', unknown: 'Наличие требует уточнения' })[offer.availability]}</p>
    {offer.availability === 'unavailable' && <p className="muted">{offer.selectable === true ? 'Выбор разрешён сервером.' : offer.selectable === false ? 'Сервер пока не разрешает выбор.' : 'Разрешение на выбор не передано сервером.'} Статус фида не обещает срок поставки.</p>}
    {source?.snapshot_at && <p className="muted">Цена и наличие относятся к снимку источника.</p>}
    </div>
    <div className="offer-actions">{!readOnly && onSelect && <button type="button" className="offer-select" disabled={disabled || selected || !selectable} onClick={() => onSelect(offer)}>{selected && <Icon name="check" />}{selected ? 'Выбрано' : 'Выбрать'}</button>}
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Открыть в Store<Icon name="external" /></a>}
    </div>
  </article>
}
