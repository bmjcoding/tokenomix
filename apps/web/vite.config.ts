import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portBase = Number(process.env.PORT_BASE ?? 3000);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: portBase,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${portBase + 1}`,
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      '@tokenomix/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
