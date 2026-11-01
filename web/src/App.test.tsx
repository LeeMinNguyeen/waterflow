import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeApi, currencies } from './test/fakeApi'

// jsdom has no ResizeObserver; the charts only need it to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const me = (language: 'en' | 'vi') => ({
  id: 'u1', profile: { username: 'lan', display_name: null, language, timezone: 'Asia/Ho_Chi_Minh', created_at: '2026-10-20T00:00:00Z',
    deletion_requested_at: null, is_admin: false, idle_sign_out_minutes: null },
})

// The whole app at an address, as a fresh page load: the language, the session and the router start from this browser's storage.
async function open(path: string, account: 'en' | 'vi', { signedIn = false } = {}) {
  const api = fakeApi({
    'GET /v1/instance': { name: 'Nhà', signup: 'invite', setup_needed: false },
    'GET /v1/currencies': currencies,
    'POST /v1/auth/sign-in': { token: 'new-token', device_token: null },
    'GET /v1/me': me(account),
    'GET /v1/books': [],
  })
  if (signedIn) localStorage.setItem('waterflow.session', 'token')
  else localStorage.removeItem('waterflow.session')
  window.history.replaceState(null, '', path)
  vi.resetModules()
  const { session } = await import('./auth/session')
  const { default: App } = await import('./App')
  const { AppTheme } = await import('./components/AppTheme')
  const { DatesProvider } = await import('./components/DatesProvider')
  const { ToastProvider } = await import('./components/ToastProvider')
  render(
    <AppTheme>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DatesProvider><ToastProvider><App /></ToastProvider></DatesProvider>
      </QueryClientProvider>
    </AppTheme>,
  )
  return { api, session }
}

async function signIn(button: string) {
  await userEvent.type(await screen.findByRole('textbox', { name: /^(Username|Tên người dùng)/ }), 'lan')
  await userEvent.type(screen.getByLabelText(/^(Password|Mật khẩu)/), 'a long password')
  await userEvent.click(screen.getByRole('button', { name: button }))
}

describe('the sign-in language and the account language (waterflow#134)', () => {
  afterEach(() => localStorage.clear())

  it("signs in from a Vietnamese sign-in screen to an English account, and signs out to Vietnamese again", async () => {
    localStorage.setItem('waterflow.language', 'vi')
    const { api, session } = await open('/sign-in', 'en')
    expect(await screen.findByRole('button', { name: 'Tiếng Việt ▾' })).toBeInTheDocument()
    await signIn('Đăng nhập')
    expect(await screen.findByRole('heading', { name: 'Create a book' })).toBeInTheDocument()
    expect(localStorage.getItem('waterflow.language')).toBe('vi')
    act(() => session.set(null))
    expect(await screen.findByRole('button', { name: 'Đăng nhập' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tiếng Việt ▾' })).toBeInTheDocument()
    expect(localStorage.getItem('waterflow.accountLanguage')).toBeNull()
    expect(api.writes().filter((c) => c.path === '/v1/me')).toEqual([])
  })

  it("on a browser with nothing saved: English to sign in, the account's language once in, English after signing out; the account keeps its language", async () => {
    const { api, session } = await open('/sign-in', 'vi')
    expect(await screen.findByRole('button', { name: 'English ▾' })).toBeInTheDocument()
    await signIn('Sign in')
    expect(await screen.findByRole('heading', { name: 'Tạo sổ' })).toBeInTheDocument()
    expect(localStorage.getItem('waterflow.language')).toBeNull()
    act(() => session.set(null))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(api.writes().filter((c) => c.path === '/v1/me')).toEqual([])
  })

  it("opens a signed-in page in the account's language straight away on a reload", async () => {
    localStorage.setItem('waterflow.language', 'en')
    localStorage.setItem('waterflow.accountLanguage', 'vi')
    await open('/books/new', 'vi', { signedIn: true })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()   // still loading the account
    expect(document.documentElement.lang).toBe('vi')
    expect(await screen.findByRole('heading', { name: 'Tạo sổ' })).toBeInTheDocument()
  })

  it('switches to the sign-in language when another tab signs out', async () => {
    localStorage.setItem('waterflow.language', 'vi')
    localStorage.setItem('waterflow.accountLanguage', 'en')
    await open('/books/new', 'en', { signedIn: true })
    expect(await screen.findByRole('heading', { name: 'Create a book' })).toBeInTheDocument()
    localStorage.removeItem('waterflow.session')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'waterflow.session', newValue: null })) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeInTheDocument())
  })
})
