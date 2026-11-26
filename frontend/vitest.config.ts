import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [process.cwd(), resolve(process.cwd(), '../contracts')] } },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:5173' } },
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
