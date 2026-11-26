import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../../../shared/ui/Icon'

function resizeTextarea(element: HTMLTextAreaElement) {
  const style = getComputedStyle(element)
  const min = parseFloat(style.minHeight) || 28
  const max = parseFloat(style.maxHeight) || 160
  element.style.height = '0px'
  const contentHeight = element.value ? element.scrollHeight : min
  element.style.height = `${Math.min(max, Math.max(min, contentHeight))}px`
  element.style.overflowY = contentHeight > max ? 'auto' : 'hidden'
}

export function MessageComposer({ disabled, suggestion, onSend, onEdited }: {
  disabled: boolean; suggestion: string; onSend: (text: string) => Promise<string | null>; onEdited: () => void
}) {
  const [text, setText] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const value = suggestion || text
  useLayoutEffect(() => {
    if (textarea.current) resizeTextarea(textarea.current)
  }, [value])
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let width = element.getBoundingClientRect().width
    let frame = 0
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => resizeTextarea(element))
      }
    })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (disabled || !value.trim()) return
    const sentText = value
    void onSend(value).then((rejected) => { if (rejected) setText((current) => current || rejected) })
      .catch(() => setText((current) => current || sentText))
    setText(''); onEdited()
  }
  return <form className="composer" aria-label="Ввод сообщения" onSubmit={submit} onClick={(event) => {
    if (event.target instanceof Element && !event.target.closest('button')) textarea.current?.focus()
  }}>
    <label className="sr-only" htmlFor="message">Ваше сообщение</label>
    <div className="composer-input"><div className="composer-text-area">
    <textarea ref={textarea} id="message" name="message" value={value} rows={1} placeholder="Напишите сообщение..."
      onChange={(event) => { setText(event.target.value); onEdited() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
      }} />
    </div>
      <button type="submit" className="primary" aria-label="Отправить" title="Отправить сообщение" disabled={disabled || !value.trim()}><Icon name="send" /></button>
    </div>
  </form>
}
