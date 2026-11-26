import { isApiError } from './guards'
import type { ApiErrorBody } from './types'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
  }
}

export async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response
  const value: unknown = await response.json().catch(() => null)
  if (isApiError(value)) throw new ApiError(response.status, value)
  throw new ApiError(response.status, {
    code: 'HTTP_ERROR', message: `Сервис вернул ошибку (${response.status}). Попробуйте позже.`, request_id: '',
  })
}

export async function jsonRequest<T>(path: string, guard: (v: unknown) => v is T, init: RequestInit = {}): Promise<T> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  const response = await requireOk(await fetch(new URL(path, window.location.origin), { ...init, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }))
  const value: unknown = await response.json()
  if (!guard(value)) throw new Error('Ответ сервиса не соответствует контракту. Попробуйте восстановить диалог.')
  return value
}
