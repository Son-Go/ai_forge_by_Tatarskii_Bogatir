import { expect, it } from 'vitest'
import { isOffer, isSource, parseEvent } from './guards'

it('requires a source timestamp and validates both when provided', () => {
  const base = { id: 's', title: 'Source', url: 'https://example.com', kind: 'catalog' }
  expect(isSource(base)).toBe(false)
  expect(isSource({ ...base, snapshot_at: '2026-11-26T10:00:00Z' })).toBe(true)
  expect(isSource({ ...base, snapshot_at: '2026-11-26T10:00:00Z', checked_at: 'invalid' })).toBe(false)
})
it('accepts unknown card attributes, but rejects invalid monetary fields', () => {
  const card = { offer_id: 'one', catalog_version: crypto.randomUUID(), name: 'Demo', product_url: 'https://example.com',
    price: null, availability: 'unknown', attributes: { seats: 50, edition: null }, source_ids: [] }
  expect(isOffer(card)).toBe(true)
  expect(isOffer({ ...card, price: { amount: 1200, currency: 'RUB' } })).toBe(false)
  expect(() => parseEvent('failed', { turn_id: 'x', code: 'X', message: 'Error' })).toThrow()
})
