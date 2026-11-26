import { expect, it } from 'vitest'
import { parseAppRoute } from './useAppRoute'

it('opens real UUID handoffs and existing synthetic routes without creating a client route', () => {
  for (const id of ['22222222-2222-4222-8222-222222222222', 'DEMO-1024', 'ABCDEFAB-1234-4567-ABCD-123456ABCDEF']) {
    expect(parseAppRoute(`#/manager/${id}`)).toEqual({ section: 'manager', caseId: id.startsWith('DEMO-') ? id : id.toLowerCase() })
  }
  expect(parseAppRoute('#/manager/../../api')).toEqual({ section: 'chat', caseId: null })
})
