import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式: npm run dev (前端) 搭配 `vat dashboard` (后端 API) 使用
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
