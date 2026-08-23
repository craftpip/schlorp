import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:6767",
      "/health": "http://localhost:6767",
      "/media": "http://localhost:6767",
      "/ws": { target: "ws://localhost:6767", ws: true },
    },
  },
})
