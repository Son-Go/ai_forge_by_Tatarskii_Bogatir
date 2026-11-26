import type { HandoffCase } from '../../entities/handoff/types'
import type { Message, Offer, Source } from '../../shared/api/types'

const source: Source = { id: 'demo-kb', title: 'Условия покупки · демонстрационный источник', url: 'https://store.softline.ru/delivery_info/', kind: 'knowledge', checked_at: '2026-11-26T08:00:00Z' }
const offer: Offer = { offer_id: 'demo-mdaemon', catalog_version: 'da0f8b53-1f33-41d5-a96f-ef36c377e3c0', name: 'MDaemon · пример корпоративной лицензии', product_url: 'https://store.softline.ru/alt-n-technologies-ltd/alt-n-technologies-mdaemon-email-server/', price: null, availability: 'unknown', attributes: { seats: 50, license_kind: 'new', edition: null, platform: null }, source_ids: [] }
function messages(id: string, lines: string[], start = '2026-11-26T08:40:00Z'): Message[] {
  return lines.map((text, index) => ({ id: `${id}-${index}`, role: index % 2 ? 'assistant' : 'user', text, status: 'complete', created_at: new Date(Date.parse(start) + index * 60000).toISOString(), cards: [], sources: [] }))
}

// Hand-labelled synthetic scenarios based on the brief. No customer transcripts or
// inferred commercial facts are copied into these examples.
export const demoCases: HandoffCase[] = [
  {
    id: 'DEMO-1024', sessionId: 'fixture-price', title: 'Лицензия MDaemon на 50 пользователей', reason: 'price', status: 'queued', createdAt: '2026-11-26T09:42:00Z',
    explanation: 'Цена отсутствует, а редакция Standard не подтверждена. Требуется проверка конкретной позиции и условий лицензии специалистом.',
    requirements: [
      { label: 'Продукт', value: 'MDaemon', evidence: 'Назван клиентом в демодиалоге' },
      { label: 'Пользователи', value: '50', evidence: 'Указано клиентом в демодиалоге' },
      { label: 'Тип покупки', value: 'Новая лицензия', evidence: 'Указано клиентом в демодиалоге' },
      { label: 'Редакция', value: null, evidence: 'Standard запрошена, но не подтверждена каталогом' },
      { label: 'Платформа', value: null, evidence: 'Клиент ещё не уточнил инфраструктуру' },
      { label: 'Срок лицензии', value: null, evidence: 'Требует уточнения у клиента' },
    ],
    messages: messages('price', ['Нужен MDaemon Standard для 50 пользователей. Покупаем новую лицензию.', 'Нашёл семейство MDaemon. Редакцию Standard и цену по имеющимся данным подтвердить не могу. Нужна проверка менеджера.', 'Важно уточнить именно редакцию Standard.', 'Редакция требует подтверждения. Цена в демонстрационной карточке не указана.']),
    offers: [offer], sources: [source],
  },
  {
    id: 'DEMO-1023', sessionId: 'fixture-documents', title: 'Подтверждение учебного статуса', reason: 'documents', status: 'in_progress', createdAt: '2026-11-26T09:18:00Z',
    explanation: 'Клиент просит проверить справку для академической лицензии. Подтверждение права на специальные условия требует человека.',
    requirements: [{ label: 'Задача', value: 'Академическая лицензия', evidence: 'Синтетический запрос клиента' }, { label: 'Документы', value: null, evidence: 'Загрузка файлов в текущем контракте отсутствует' }, { label: 'Продукт', value: null, evidence: 'Не уточнён' }],
    messages: messages('documents', ['Какие документы нужны для покупки академической лицензии?', 'Общий порядок можно посмотреть в условиях покупки. Проверить право на академические условия должен менеджер.', 'Наша организация — учебное заведение. Что нужно уточнить?', 'Право на специальные условия требует отдельной проверки. Файлы и персональные данные в этом примере не используются.']), offers: [], sources: [source],
  },
  {
    id: 'DEMO-1022', sessionId: 'fixture-supply', title: 'Запрос на продукт вне витрины', reason: 'supply', status: 'queued', createdAt: '2026-11-26T08:55:00Z',
    explanation: 'Точное предложение в каталоге не найдено. Возможность поставки, стоимость и сроки должен подтвердить менеджер.',
    requirements: [{ label: 'Задача', value: 'Поставка вне каталога', evidence: 'Синтетический запрос клиента' }, { label: 'Название / артикул', value: null, evidence: 'Нужно уточнить точную модель' }, { label: 'Количество', value: null, evidence: 'Не указано' }],
    messages: messages('supply', ['В каталоге нет нужного продукта. Можно заказать у партнёра?', 'Нужно уточнить название или артикул. Подтвердить возможность поставки и её условия сможет специалист.']), offers: [], sources: [],
  },
  {
    id: 'DEMO-1021', sessionId: 'fixture-completed', title: 'Консультация по условиям покупки', reason: 'complex', status: 'resolved', createdAt: '2026-11-26T07:50:00Z',
    explanation: 'Синтетический пример завершённой консультации. Клиент получил разъяснение по общему порядку покупки.',
    requirements: [{ label: 'Тема', value: 'Условия покупки', evidence: 'Синтетический справочный вопрос' }],
    messages: messages('completed', ['Где посмотреть порядок оплаты и доставки?', 'Общие условия опубликованы на странице оплаты и доставки Softline. Условия конкретного заказа нужно подтвердить отдельно.'], '2026-11-26T07:40:00Z'),
    offers: [], sources: [source],
  },
]
