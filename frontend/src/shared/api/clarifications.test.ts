import { expect, it } from 'vitest'
import { isOffer, isSession } from './guards'
import { isAssignedHandoff, isHandoff } from './handoffApi'

const id = '11111111-1111-4111-8111-111111111111'
const offer = { offer_id: 'synthetic-offer', catalog_version: id, name: 'Синтетическая лицензия', product_url: 'https://example.com/product', price: { amount: '10000', currency: 'RUB' }, availability: 'unavailable', attributes: {}, source_ids: [], selectable: true }
const session = { session_id: id, selected_offer: offer, messages: [], last_turn: null, quotes_enabled: true }
const handoff = { handoff_id: id, session_id: id, reason: 'payment_deferral', status: 'in_progress', created_at: '2026-11-27T10:00:00Z' }
const sales = { offer, quote: { quote_id: id, quantity: 2, approved: true, discount_percent: '5', agreed_total: '19000', price: offer.price } }

it.each(['key_delivery', 'key_activation', 'refund'])('accepts the documented support topic %s, without a local inference', (support_topic) => {
  expect(isSession({ ...session, support_topic })).toBe(true)
})

it('accepts legacy omissions, but rejects invented support topics and permission types', () => {
  expect(isSession(session)).toBe(true)
  expect(isSession({ ...session, support_topic: 'invented' })).toBe(false)
  expect(isSession({ ...session, support_topic: null })).toBe(false)
  expect(isOffer({ ...offer, selectable: false })).toBe(true)
  expect(isOffer({ ...offer, selectable: 'true' })).toBe(false)
})

it('validates server price terms without calculating or replacing its monetary values', () => {
  const price_terms = { base_amount: '10000.125', discount_percent: '5', final_amount: '9500.12', currency: 'RUB' }
  expect(isSession({ ...session, price_terms })).toBe(true)
  for (const invalid of [{ discount_percent: '5.01' }, { discount_percent: '-1' }, { discount_percent: '5%' }, { final_amount: 9500 }, { currency: 'rub' }, { base_amount: '1e4' }]) {
    expect(isSession({ ...session, price_terms: { ...price_terms, ...invalid } })).toBe(false)
  }
  expect(isSession({ ...session, price_terms: null })).toBe(false)
})

it.each(['instruction_failed', 'payment_deferral'])('accepts the actual new manager reason %s and its available sales snapshot', (reason) => {
  expect(isHandoff({ ...handoff, reason })).toBe(true)
  expect(isAssignedHandoff({ handoff: { ...handoff, reason }, messages: [], sales_context: sales })).toBe(true)
})

it('follows SalesContext required fields and quantity minimum, including nullable and absent snapshots', () => {
  const context = { handoff, messages: [] }
  expect(isAssignedHandoff(context)).toBe(true)
  expect(isAssignedHandoff({ ...context, sales_context: null })).toBe(true)
  expect(isAssignedHandoff({ ...context, sales_context: { offer: null, quote: null } })).toBe(true)
  for (const quantity of [0, -1, 1.5, '1']) expect(isAssignedHandoff({ ...context, sales_context: { ...sales, quote: { ...sales.quote, quantity } } })).toBe(false)
  expect(isAssignedHandoff({ ...context, sales_context: { offer } })).toBe(false)
  expect(isAssignedHandoff({ ...context, sales_context: { quote: sales.quote } })).toBe(false)
  expect(isHandoff({ ...handoff, reason: 'invented' })).toBe(false)
})
