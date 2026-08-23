import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/media": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
})
