import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { canvasStoragePlugin } from './server/middleware.mjs'

export default defineConfig({
  plugins: [react(), canvasStoragePlugin()],
  server: {
    host: '127.0.0.1',
    port: 43217
  }
})
