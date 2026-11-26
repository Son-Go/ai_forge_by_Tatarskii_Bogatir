import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import { handlers, resetMockDb } from '../mocks/handlers'

export const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetMockDb() })
afterEach(() => { cleanup(); server.resetHandlers() })
afterAll(() => server.close())
