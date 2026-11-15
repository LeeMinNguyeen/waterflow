import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Instance, Me } from '../lib/api'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Admin } from './Admin'

const admin: Me = {
  id: 'u1',
  profile: { username: 'admin', display_name: null, timezone: 'Asia/Ho_Chi_Minh', language: 'en', created_at: '2026-10-01T00:00:00Z',
    deletion_requested_at: null, is_admin: true, idle_sign_out_minutes: null },
}
const instance: Instance = { name: 'Nhà', server_version: '0.6.0', api_version: 1, signup: 'invite', setup_needed: false, account_purge: 'on', usage_stats: 'on' }

const days = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 9, 14 + i)).toISOString().slice(0, 10), people: i % 5 }))
const numbers = {
  collecting: true, keep_days: 90, since: '2026-10-01',
  people: { accounts: 14, new_this_month: 2, today: 6, days_7: 9, days_30: 12 },
  days,
  features: [
    { feature: 'transaction_expense', people: 12, times: 412 },
    { feature: 'transfers_new_thing', people: 3, times: 1 },
    { feature: 'budget', people: 2, times: 6 },
  ],
  server: { books: 21, shared_books: 4 },
}
const off = { ...numbers, collecting: false, since: null, days: [], features: [], people: { accounts: 1, new_this_month: 0, today: 0, days_7: 0, days_30: 0 }, server: { books: 0, shared_books: 0 } }

function server(usage: unknown = numbers) {
  return fakeApi({
    'GET /v1/me': admin,
    'GET /v1/instance': instance,
    'PATCH /v1/admin/instance': undefined,
    'GET /v1/admin/usage': usage,
    'DELETE /v1/admin/usage': undefined,
    'GET /v1/admin/update': { current_version: '0.6.0', latest_version: '0.6.0', release_url: null, changelog_url: null, update_available: false, updater: false, status: null },
    'GET /v1/admin/invites': [],
    'GET /v1/admin/users': [],
    'GET /v1/admin/jobs': [],
    'GET /v1/admin/restore': null,
    'GET /v1/admin/backups': [],
    'GET /v1/auth/two-factor': { enabled: false, recovery_codes_left: 0 },
  })
}

describe('the Usage tab on Server admin (waterflow#229)', () => {
  it('shows the Server tab first and the Usage tab at ?tab=usage', async () => {
    server()
    await renderApp(<Admin />)
    expect(await screen.findByRole('heading', { name: 'Updates' })).toBeInTheDocument()
    expect(screen.queryByText('Features, last 30 days')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    expect(await screen.findByText('Features, last 30 days')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('?tab=usage')
    expect(screen.queryByRole('heading', { name: 'Updates' })).not.toBeInTheDocument()
  })

  it('opens the Usage tab from the address', async () => {
    server()
    await renderApp(<Admin />, { route: '/admin?tab=usage' })
    expect(await screen.findByText('Features, last 30 days')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Usage', selected: true })).toBeInTheDocument()
  })

  it('shows the tiles, the days and each feature with its people and times, in the order given', async () => {
    server()
    await renderApp(<Admin />, { route: '/admin?tab=usage' })
    const tile = async (label: string, value: string) => expect((await screen.findByText(label)).parentElement).toHaveTextContent(value)
    await tile('People', '14')
    await tile('Active today', '6')
    await tile('Last 7 days', '9')
    await tile('Last 30 days', '12')
    await tile('New this month', '2')
    await tile('Books', '21')
    await tile('Shared', '4')
    expect(screen.getAllByTitle(/: \d+ (people|person)$/)).toHaveLength(30)
    const rows = (await screen.findAllByRole('progressbar')).map((b) => b.getAttribute('aria-label'))
    expect(rows).toEqual(['Add an expense', 'transfers_new_thing', 'Budgets'])
    expect(screen.getByText('12 people · 412 times')).toBeInTheDocument()
    expect(screen.getByText('3 people · 1 time')).toBeInTheDocument()
  })

  it('shows the off state without numbers, and the switch turns collecting on', async () => {
    const api = server(off)
    await renderApp(<Admin />, { route: '/admin?tab=usage' })
    expect(await screen.findByText('Usage numbers are off')).toBeInTheDocument()
    expect(screen.queryByText('Features, last 30 days')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Keep for' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('switch', { name: 'Collect usage numbers' }))
    await waitFor(() => expect(api.writes()).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/v1/admin/instance', body: { usage_stats: 'on' } })))
  })

  it('sends the retention', async () => {
    const api = server()
    await renderApp(<Admin />, { route: '/admin?tab=usage' })
    await userEvent.click(await screen.findByRole('combobox', { name: 'Keep for' }))
    await userEvent.click(await screen.findByRole('option', { name: '180 days' }))
    await waitFor(() => expect(api.writes()).toContainEqual(expect.objectContaining({ path: '/v1/admin/instance', body: { usage_keep_days: 180 } })))
  })

  it('asks before deleting the numbers', async () => {
    const api = server()
    await renderApp(<Admin />, { route: '/admin?tab=usage' })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete the numbers collected' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(api.writes()).toHaveLength(0)
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(api.writes()).toHaveLength(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete the numbers collected' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.writes()).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/v1/admin/usage' })))
  })

  it('reads in Vietnamese', async () => {
    server()
    await renderApp(<Admin />, { route: '/admin?tab=usage', lang: 'vi' })
    expect(await screen.findByText('Tính năng được dùng, 30 ngày qua')).toBeInTheDocument()
    expect(screen.getByText('12 người · 412 lần')).toBeInTheDocument()
    expect(screen.getByText('Thêm khoản chi')).toBeInTheDocument()
  })
})
