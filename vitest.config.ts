import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tokenomix/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
