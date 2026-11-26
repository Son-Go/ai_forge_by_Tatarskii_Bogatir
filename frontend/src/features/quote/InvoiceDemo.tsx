import { useId, useState } from 'react'
import { Icon } from '../../shared/ui/Icon'

// Isolated visual prototype. No invoice DTO, endpoint, document or tax calculation.
export function InvoiceDemo() {
  const id = useId()
  const [customer, setCustomer] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [preview, setPreview] = useState<{ customer: string; quantity: string } | null>(null)
  return <details className="invoice-demo"><summary><Icon name="file" />Счёт · демонстрация</summary>
    <p className="muted">Макет формы на синтетических данных. Настоящий счёт не создаётся; итог и НДС не рассчитываются.</p>
    <form className="quote-form" aria-label="Демонстрация формы счёта" onSubmit={(event) => { event.preventDefault(); if (customer.trim()) setPreview({ customer: customer.trim(), quantity }) }}>
      <label htmlFor={`${id}-customer`}>Заказчик · демо</label><input id={`${id}-customer`} required value={customer} onChange={(event) => { setCustomer(event.target.value); setPreview(null) }} />
      <label htmlFor={`${id}-quantity`}>Количество позиций · демо</label><input id={`${id}-quantity`} type="number" min="1" step="1" required value={quantity} onChange={(event) => { setQuantity(event.target.value); setPreview(null) }} />
      <button type="submit">Показать демопредпросмотр</button>
    </form>
    {preview && <div className="invoice-preview" role="status"><strong>Демонстрационный предпросмотр</strong><p>{preview.customer} · позиций: {preview.quantity}</p><p>Это не платёжный документ. Скачивание недоступно.</p></div>}
  </details>
}
