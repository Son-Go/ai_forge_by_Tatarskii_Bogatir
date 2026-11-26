import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { MessageComposer } from './MessageComposer'

it('supports multiline input, prevents empty sends and restores a rejected draft', async () => {
  const user = userEvent.setup()
  const send = vi.fn(async (text: string) => text)
  render(<MessageComposer disabled={false} suggestion="" onEdited={() => {}} onSend={send} />)
  const input = screen.getByRole('textbox', { name: 'Ваше сообщение' })
  expect(screen.getByRole('button', { name: /Отправить/ })).toBeDisabled()
  await user.type(input, 'Лицензия')
  await user.keyboard('{Shift>}{Enter}{/Shift}на 50 человек')
  expect(input).toHaveValue('Лицензия\nна 50 человек')
  await user.keyboard('{Enter}')
  expect(send).toHaveBeenCalledWith('Лицензия\nна 50 человек')
  await waitFor(() => expect(input).toHaveValue('Лицензия\nна 50 человек'))
})

it('allows drafting during a turn but blocks send, including keyboard submit', async () => {
  const user = userEvent.setup()
  const send = vi.fn(async () => null)
  render(<MessageComposer disabled suggestion="" onEdited={() => {}} onSend={send} />)
  await user.type(screen.getByRole('textbox'), 'Следующий вопрос{Enter}')
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('Следующий вопрос')
})

it('focuses the input from the composer surface without intercepting send', async () => {
  const user = userEvent.setup()
  const send = vi.fn(async () => null)
  render(<MessageComposer disabled={false} suggestion="" onEdited={() => {}} onSend={send} />)
  await user.click(screen.getByRole('form', { name: 'Ввод сообщения' }))
  const input = screen.getByRole('textbox')
  expect(input).toHaveFocus()
  expect(send).not.toHaveBeenCalled()
  await user.type(input, 'Проверка области ввода')
  await user.click(screen.getByRole('button', { name: 'Отправить' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('Проверка области ввода')
})
