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
        configure: (proxy) => {
          // The backend may not be listening yet during `pnpm dev` startup.
          // Swallow the expected connection errors (no stack-trace spam) and
          // return a quiet 503 so the client retries cleanly.
          proxy.on('error', (err, _req, res) => {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
              if (res && 'writeHead' in res && !res.writableEnded) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end('{"error":"backend starting"}');
              }
              return;
            }
            console.warn(`[vite] proxy error: ${err.message}`);
          });
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
  },
  resolve: {
    alias: {
      '@tokenomix/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
