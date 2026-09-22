import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  server: {
    host: true,
    // Khi phát triển trên máy: /cms-api chuyển tới máy chủ CMS (npm run cms).
    // Giữ nguyên header Host để máy chủ CMS so khớp được với Origin (chống CSRF), giống Nginx.
    proxy: {
      '/cms-api': { target: 'http://127.0.0.1:4310', changeOrigin: false },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: {
        main: root('./index.html'),
        admin: root('./admin/index.html'),
      },
    },
  },
});
