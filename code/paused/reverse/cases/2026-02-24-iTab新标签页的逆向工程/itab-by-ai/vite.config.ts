import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue'],
          'utils': ['axios', 'dayjs', 'localforage']
        }
      }
    },
    // 保留 .vue 文件扩展名
    chunkFileNames: 'chunks/[name]-[hash].js',
    entryFileNames: '[name].js',
    assetFileNames: 'assets/[name]-[hash][extname]'
  },
  publicDir: 'public'
})
