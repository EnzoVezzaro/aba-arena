import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev, the UI runs on its own port and proxies API calls to the ABA
// backend (default http://localhost:4317).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5199,
    proxy: {
      '/api': {
        target: process.env.ABA_API_TARGET || 'http://localhost:4317',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
