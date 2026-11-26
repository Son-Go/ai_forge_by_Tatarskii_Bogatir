import { expect, it } from 'vitest'
import { formatPrice, safeUrl } from './presentation'

it('does not round decimal monetary strings or label zero/missing prices free', () => {
  expect(formatPrice({ amount: '9007199254740993.01', currency: 'RUB' })).toBe('9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993,01\u00a0₽')
  expect(formatPrice(null)).toContain('уточнения')
  expect(formatPrice({ amount: '0.00', currency: 'RUB' })).toContain('уточнения')
})
it('allows HTTPS links and rejects executable, relative or credentialed URLs', () => {
  expect(safeUrl('https://example.com/test')).toBe('https://example.com/test')
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '/api', 'http://example.com', 'https://user:password@example.com']) expect(safeUrl(url)).toBeNull()
})
