import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionPreferenceProvider } from './providers/MotionPreferenceProvider.js';
import { QueryProvider } from './providers/QueryProvider.js';
import { RefreshModeProvider } from './providers/RefreshModeProvider.js';
import { ThemeProvider } from './providers/ThemeProvider.js';
import { router } from './router.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in document.');
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <RefreshModeProvider>
        <MotionPreferenceProvider>
          <QueryProvider>
            <RouterProvider router={router} />
          </QueryProvider>
        </MotionPreferenceProvider>
      </RefreshModeProvider>
    </ThemeProvider>
  </StrictMode>
);
