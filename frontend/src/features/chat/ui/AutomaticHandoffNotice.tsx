import { Icon } from '../../../shared/ui/Icon'

// Presentation model only. A future agreed Backend adapter must supply this;
// neither insufficient_data nor a missing price implies a confirmed handoff.
export interface AutomaticHandoffNoticeData {
  message: string
  caseReference?: string
  title?: string
}

export function AutomaticHandoffNotice({ notice }: { notice?: AutomaticHandoffNoticeData }) {
  if (!notice) return null
  return <section className="system-notice" role="status" aria-label="Автоматическая передача обращения">
    <Icon name="inbox" /><div><strong>{notice.title || 'Обращение передано специалисту'}</strong><p>{notice.message}</p>
      {notice.caseReference && <small>Номер обращения: {notice.caseReference}</small>}
    </div>
  </section>
}
