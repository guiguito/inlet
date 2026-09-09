import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import { App } from './App';
import { initTheme } from './components/theme-toggle';
import './index.css';

/**
 * FR-136 and FR-144: a hosted form reads no browser storage, so the management
 * interface's stored theme is not consulted there, and the class that carries it is
 * removed. A hosted form's colours are the operator's branding and nothing else.
 */
if (window.location.pathname.startsWith('/f/')) {
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('inlet-hosted');
} else {
  initTheme();
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('The #root element is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        {/* Motion stays limited to component transitions (PRD section 20.5). */}
        <Toaster position="bottom-right" closeButton richColors={false} />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
