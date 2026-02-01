import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: {
      '/health': 'http://localhost:3000',
      '/accounts': 'http://localhost:3000',
      '/articles': 'http://localhost:3000',
      '/publish-jobs': 'http://localhost:3000',
      '/config': 'http://localhost:3000',
      '/auto-schedule': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'production',
    emptyOutDir: true,
  },
  base: '/',
}))
