import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    publicDir: mode === 'mock' ? 'public' : false,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      fs: { allow: [process.cwd(), resolve(process.cwd(), '../contracts')] },
      proxy: mode === 'mock' ? undefined : {
        '/api': { target: env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:8080' },
        '/health': { target: env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:8080' },
      },
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: { sourcemap: false },
  }
})
