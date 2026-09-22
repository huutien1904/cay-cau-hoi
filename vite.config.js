import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
  },
});
