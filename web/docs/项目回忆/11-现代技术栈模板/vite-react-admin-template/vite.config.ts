import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mockApi } from './mock/server.ts';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // 开发期内置 mock（对标原模板 data/*.json 的角色）。
    // 对接真实后端时：删除 mockApi() 并启用下方 proxy。
    mockApi(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    // 沿用原模板的 8888 端口
    port: 8888,
    // proxy: {
    //   '/api': {
    //     target: 'http://127.0.0.1:3000', // TODO 改成你的后端服务地址
    //     changeOrigin: true,
    //   },
    // },
  },
});
