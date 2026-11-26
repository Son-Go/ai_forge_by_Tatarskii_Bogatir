import type { components, operations } from './schema'

// The generator loses required-only anyOf/allOf branches in this contract.
// Keep this narrow adapter until the schema/generator is clarified with Backend.
export type Source = {
  id: string; title: string; url: string; kind: 'catalog' | 'store' | 'knowledge'
} & ({ snapshot_at: string; checked_at?: string } | { snapshot_at?: string; checked_at: string })
export type Offer = Omit<components['schemas']['OfferCard'], 'attributes'> & { attributes: Record<string, unknown> }
export type Message = Omit<components['schemas']['Message'], 'cards' | 'sources'> & { cards: Offer[]; sources: Source[] }
export type Session = Omit<components['schemas']['Session'], 'messages' | 'selected_offer'> & {
  messages: (Message & { status: NonNullable<Message['status']> })[]; selected_offer: Offer | null
}
export type ApiErrorBody = Omit<components['schemas']['Error'], 'updated_offer'> & { updated_offer?: Offer }
export type MessageInput = operations['submitMessage']['requestBody']['content']['application/json']
export type StreamEvents = {
  accepted: components['schemas']['AcceptedEvent']
  status: components['schemas']['StatusEvent']
  delta: components['schemas']['DeltaEvent']
  done: Omit<components['schemas']['DoneEvent'], 'message'> & { message: Message }
  failed: components['schemas']['FailedEvent']
}
export type ChatEvent = { [K in keyof StreamEvents]: { type: K; data: StreamEvents[K] } }[keyof StreamEvents]
