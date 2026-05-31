import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend API port — must match PORT in .env
const API_PORT = process.env.VITE_API_PORT || 4000

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Proxy all /api/* requests to the backend
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
      // Proxy WebSocket /ws to the backend
      '/ws': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
