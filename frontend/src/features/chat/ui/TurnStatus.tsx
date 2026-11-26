import { useEffect, useState } from 'react'

export function TurnStatus({ text, interpreting }: { text: string; interpreting: boolean }) {
  const [longWait, setLongWait] = useState(false)
  useEffect(() => {
    if (!interpreting) return
    const timer = setTimeout(() => setLongWait(true), 8000)
    return () => clearTimeout(timer)
  }, [interpreting])
  return <div className="turn-status" role="status" aria-live="polite">{text && <><span className="status-indicator"><span className="spinner" aria-hidden="true" /></span><span>{interpreting && longWait ? 'Ожидаем ответа модели…' : text}</span></>}</div>
}
