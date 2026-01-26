import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/health': 'http://localhost:3000',
      '/accounts': 'http://localhost:3000',
      '/articles': 'http://localhost:3000',
      '/publish-jobs': 'http://localhost:3000',
    },
  },
})
