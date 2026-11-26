import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { AutomaticHandoffNotice } from './AutomaticHandoffNotice'

it('never claims a handoff without explicit presentation data', () => {
  const { rerender, container } = render(<AutomaticHandoffNotice />)
  expect(container).toBeEmptyDOMElement()
  rerender(<AutomaticHandoffNotice notice={{ message: 'Системное уведомление', caseReference: 'TEST-42' }} />)
  expect(screen.getByRole('status')).toHaveTextContent('TEST-42')
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
})
