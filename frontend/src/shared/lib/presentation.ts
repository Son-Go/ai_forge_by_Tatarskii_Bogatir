import type { Offer } from '../api/types'

export function safeUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
export function formatPrice(price: Offer['price']): string {
  if (!price || /^0+(\.0+)?$/.test(price.amount)) return 'Цена требует уточнения'
  const [integer = '', fraction = ''] = price.amount.split('.')
  const grouped = integer.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  const decimal = fraction ? `,${fraction.padEnd(2, '0')}` : ''
  return `${grouped}${decimal}\u00a0${price.currency === 'RUB' ? '₽' : price.currency}`
}
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
const labels: Record<string, string> = { edition: 'Редакция', license_kind: 'Тип лицензии', seats: 'Пользователи',
  license_term_months: 'Лицензия, мес.', updates_term_months: 'Обновления, мес.', support_term_months: 'Поддержка, мес.',
  deployment: 'Развёртывание', platform: 'Платформа', vendor: 'Производитель', vendor_code: 'Артикул' }
export function attributes(offer: Offer): [string, string][] {
  return Object.entries(offer.attributes).map(([key, value]) => [labels[key] || key,
    value === null || value === '' || typeof value === 'object' ? 'Требует уточнения'
      : key === 'license_kind' && value === 'new' ? 'Новая лицензия'
      : key === 'license_kind' && value === 'renewal' ? 'Продление'
      : typeof value === 'boolean' ? value ? 'Да' : 'Нет' : String(value)])
}
