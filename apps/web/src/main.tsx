import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import { App } from './App';
import { initTheme } from './components/theme-toggle';
import './index.css';

initTheme();

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
