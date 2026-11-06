import './lib/oldStorage'
import '@fontsource-variable/inter'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { AppTheme } from './components/AppTheme'
import { DatesProvider } from './components/DatesProvider'
import { HideAmountsProvider } from './components/HideAmountsProvider'
import { ToastProvider } from './components/ToastProvider'
import { config } from './config'
import { storeUrlFor } from './lib/store'
import { forgetOnSessionChange } from './auth/sessionChange'
import './i18n'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, refetchInterval: 60_000, retry: 1 } },
})

forgetOnSessionChange(queryClient)

const store = storeUrlFor(navigator.userAgent, config)
if (store) window.location.replace(store)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppTheme>
      <QueryClientProvider client={queryClient}>
        <DatesProvider>
          <ToastProvider>
            <HideAmountsProvider>
              <App />
            </HideAmountsProvider>
          </ToastProvider>
        </DatesProvider>
      </QueryClientProvider>
    </AppTheme>
  </StrictMode>,
)
