import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Book, Dashboard as Dash } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { desktop, renderApp } from '../test/render'
import { todayIn } from '../lib/labels'
import { Dashboard } from './Dashboard'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
export const emptyDash: Dash = {
  currency: 'VND', rates_source: null, net_worth: 0, net_worth_missing_rates: 0, assets: 0, debts: 0, spent_this_month: 0, spent_last_month: 0,
  income_this_month: 0, cashflow_6_months: [], top_categories_this_month: [], budgets: [], accounts: [], people: [], recent_transactions: [],
}

export function dashServer(dash: Partial<Dash>, extra: Record<string, unknown> = {}) {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/dashboard': { ...emptyDash, ...dash },
    'GET /v1/books/b1/categories': [],
    ...extra,
  })
}

// jsdom has no ResizeObserver; the charts only need it to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

describe('Overview', () => {
  it('opens People from who owes whom (waterflow#68)', async () => {
    dashServer({ people: [{ contact_id: 'c1', name: 'Mẹ', currency: 'VND', owed_to_you: 0, you_owe: 10_000_000 }] })
    await renderApp(<Dashboard book={book} />)
    const section = await screen.findByRole('region', { name: 'Who owes whom' })
    await userEvent.click(within(section).getByRole('link', { name: 'See all' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/people')
  })
})

const row = (i: number, pinned = false) => ({ account_id: `a${i}`, name: `Account ${i}`, kind: 'cash' as const, currency: 'VND', balance: i * 1000,
  converted_balance: i * 1000, in_net_worth: true, pinned })
const txn = (i: number) => ({ id: `t${i}`, type: 'expense' as const, occurred_on: '2026-10-20', occurred_time: '08:00:00', payee: `Payee ${i}`,
  category: null, amount: -i * 1000, currency: 'VND' })
const cardOf = async (title: string) => within(await screen.findByRole('region', { name: title }))

describe('the Overview lists (waterflow#73, waterflow#74)', () => {
  it('shows the 5 latest transactions', async () => {
    dashServer({ recent_transactions: [1, 2, 3, 4, 5, 6, 7].map(txn) })
    await renderApp(<Dashboard book={book} />)
    const recent = await cardOf('Recent')
    expect(recent.getAllByText(/^Payee \d$/).map((e) => e.textContent)).toEqual(['Payee 1', 'Payee 2', 'Payee 3', 'Payee 4', 'Payee 5'])
    expect(recent.getByRole('link', { name: 'See all' })).toBeInTheDocument()
  })

  it("opens a category's transactions from its row with the keyboard too (review #166)", async () => {
    dashServer({ top_categories_this_month: [{ category_id: 'c1', category: 'Food & drink', category_parent_id: null, spent: 50_000, not_converted: 0 }] },
      { 'GET /v1/books/b1/categories': [food] })
    await renderApp(<Dashboard book={book} />)
    const row = (await cardOf('By category')).getByRole('link', { name: /Food & drink/ })
    row.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?category_id=c1')
  })

  it('says so when a transaction under Recent was deleted meanwhile (review #166)', async () => {
    dashServer({ recent_transactions: [txn(1)] }, {
      'GET /v1/books/b1/transactions/t1': new Response(JSON.stringify({ detail: 'not_found' }), { status: 404 }),
    })
    await renderApp(<Dashboard book={book} />)
    await userEvent.click((await cardOf('Recent')).getByText('Payee 1'))
    expect(await screen.findByText('Not found.')).toBeInTheDocument()
  })

  it('shows the pinned accounts', async () => {
    dashServer({ accounts: [1, 2, 3, 4, 5, 6, 7].map((i) => row(i, i === 3 || i === 6)) })
    await renderApp(<Dashboard book={book} />)
    const accounts = await cardOf('Accounts')
    expect(accounts.getAllByText(/^Account \d$/).map((e) => e.textContent)).toEqual(['Account 3', 'Account 6'])
    expect(accounts.queryByText('Pin accounts on Accounts to choose these.')).not.toBeInTheDocument()
  })

  it("leaves people's own accounts out (waterflow#85)", async () => {
    dashServer({ accounts: [{ ...row(1), name: 'Minh', kind: 'person' as const }, row(2)] })
    await renderApp(<Dashboard book={book} />)
    const accounts = await cardOf('Accounts')
    expect(accounts.getByText('Account 2')).toBeInTheDocument()
    expect(accounts.queryByText('Minh')).not.toBeInTheDocument()
  })

  it('shows the first 5 when none is pinned, and says how to choose', async () => {
    dashServer({ accounts: [1, 2, 3, 4, 5, 6, 7].map((i) => row(i)) })
    await renderApp(<Dashboard book={book} />)
    const accounts = await cardOf('Accounts')
    expect(accounts.getAllByText(/^Account \d$/)).toHaveLength(5)
    expect(accounts.getByText('Pin accounts on Accounts to choose these.')).toBeInTheDocument()
  })
})

const food = { id: 'c1', parent_id: null, name: 'Food & drink', kind: 'expense' as const, color: '#D97757', archived_at: null, version: 1 }

describe('colour for meaning (waterflow#143)', () => {
  it("draws each category's bar in the category's own colour", async () => {
    dashServer({ top_categories_this_month: [{ category_id: 'c1', category: 'Food & drink', category_parent_id: null, spent: 540_000, not_converted: 0 }] },
      { 'GET /v1/books/b1/categories': [food] })
    await renderApp(<Dashboard book={book} />)
    const bar = (await cardOf('By category')).getByRole('progressbar', { name: 'Food & drink' })
    expect(bar.firstElementChild).toHaveStyle({ backgroundColor: '#D97757' })
  })

  it('draws a budget in its category colour, and red with "over" once past its limit', async () => {
    const budget = (id: string, category: string, spent: number) => ({ budget_id: id, category_id: 'c1', excluded_category_ids: [], category, period: 'monthly',
      period_start: '2026-10-01', period_end: '2026-10-31', budget: 1_500_000, spent, remaining: 1_500_000 - spent,
      percent_used: Math.round((spent / 1_500_000) * 100), not_converted: 0 })
    dashServer({ budgets: [budget('b1', 'Food & drink', 1_640_000), budget('b2', 'Groceries', 500_000)] },
      { 'GET /v1/books/b1/categories': [food] })
    await renderApp(<Dashboard book={book} />)
    const budgets = await cardOf('Budgets')
    const over = budgets.getByRole('progressbar', { name: 'Food & drink · Monthly' })
    expect(over.firstElementChild).toHaveStyle({ backgroundColor: '#C9372C' })
    expect(budgets.getByText('₫140,000 over')).toBeInTheDocument()
    expect(budgets.getByRole('progressbar', { name: 'Groceries · Monthly' }).firstElementChild).toHaveStyle({ backgroundColor: '#D97757' })
  })

  it("opens a budget's dialog from its bar, to change it (waterflow#139)", async () => {
    dashServer({ budgets: [{ budget_id: 'bu1', category_id: 'c1', excluded_category_ids: [], category: 'Food & drink', period: 'monthly', period_start: '2026-10-01',
      period_end: '2026-10-31', budget: 1_500_000, spent: 600_000, remaining: 900_000, percent_used: 40, not_converted: 0 }] },
    { 'GET /v1/books/b1/categories': [food], 'GET /v1/books/b1/budgets': [] })
    await renderApp(<Dashboard book={book} />)
    const budgets = await cardOf('Budgets')
    await userEvent.click(budgets.getByRole('button', { name: /Food & drink · Monthly/ }))
    expect(await screen.findByRole('dialog', { name: 'Budgets · Food & drink' })).toBeInTheDocument()
  })

  it('shows spending red with its minus, income green with its plus, and a transfer plain', async () => {
    dashServer({ recent_transactions: [
      { ...txn(1), payee: 'Phở Thìn', amount: -85_000 },
      { ...txn(2), type: 'income', payee: 'Salary', amount: 32_000_000 },
      { ...txn(3), type: 'transfer', payee: null, amount: -5_000_000 },
    ] })
    await renderApp(<Dashboard book={book} />)
    const recent = await cardOf('Recent')
    expect(recent.getByText('−₫85,000')).toHaveStyle({ color: '#C9372C' })
    expect(recent.getByText('+₫32,000,000')).toHaveStyle({ color: '#18803E' })
    expect(recent.getByText('₫5,000,000')).toHaveStyle({ color: '#18181B' })
  })

  it('shows a card that owes money in red', async () => {
    dashServer({ accounts: [{ ...row(1), name: 'VIB card', kind: 'credit_card' as const, balance: -6_850_000, converted_balance: -6_850_000 }] })
    await renderApp(<Dashboard book={book} />)
    expect((await cardOf('Accounts')).getByText('−₫6,850,000')).toHaveStyle({ color: '#C9372C' })
  })
})

describe('the design, line by line (waterflow#143)', () => {
  it('says Today and Yesterday in the recent list', async () => {
    const today = todayIn(book.timezone)
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    dashServer({ recent_transactions: [{ ...txn(1), occurred_on: today }, { ...txn(2), occurred_on: yesterday }] })
    await renderApp(<Dashboard book={book} />)
    const recent = await cardOf('Recent')
    expect(recent.getByText(/^Today/)).toBeInTheDocument()
    expect(recent.getByText(/^Yesterday/)).toBeInTheDocument()
  })

  it("puts the chart's legend in its section's title row", async () => {
    dashServer({})
    await renderApp(<Dashboard book={book} />)
    const title = (await screen.findByRole('heading', { name: 'Spending and income' })).parentElement!
    expect(within(title).getByText('Spending')).toBeInTheDocument()
    expect(within(title).getByText('Income')).toBeInTheDocument()
  })
})

describe('two columns that take only the height they need (waterflow#150)', () => {
  afterEach(() => desktop(false))

  it('stacks each column with a divider between sections', async () => {
    desktop(true)
    dashServer({ accounts: [row(1)], recent_transactions: [txn(1)] })
    await renderApp(<Dashboard book={book} />)
    const next = (name: string) => screen.getByRole('region', { name }).nextElementSibling
    await screen.findByRole('region', { name: 'Accounts' })
    expect(next('By category')).toHaveRole('separator')
    expect(next('By category')!.nextElementSibling).toBe(screen.getByRole('region', { name: 'Accounts' }))
    expect(next('Spending and income')!.nextElementSibling).toBe(screen.getByRole('region', { name: 'Recent' }))
  })
})

describe('the budget for all spending (waterflow#122)', () => {
  it('comes first, named with what it leaves out, and opens its dialog', async () => {
    dashServer({ budgets: [{ budget_id: 'bu9', category_id: null, category: null, excluded_category_ids: ['c1'], period: 'monthly',
      period_start: '2026-11-01', period_end: '2026-11-30', budget: 15_000_000, spent: 600_000, remaining: 14_400_000, percent_used: 4,
      not_converted: 0 }] }, { 'GET /v1/books/b1/categories': [food], 'GET /v1/books/b1/budgets': [] })
    await renderApp(<Dashboard book={book} />)
    const budgets = await cardOf('Budgets')
    await userEvent.click(await budgets.findByText('All spending except Food & drink · Monthly'))
    expect(await screen.findByRole('heading', { name: 'Budgets · All spending' })).toBeInTheDocument()
  })
})

describe('assets and debts (waterflow#138)', () => {
  it('shows them under net worth in small text, the debts without a minus', async () => {
    dashServer({ net_worth: 249_752_750, assets: 256_602_750, debts: 6_850_000 })
    await renderApp(<Dashboard book={book} />)
    const line = await screen.findByText((_, el) => el?.tagName === 'P' && /^Assets/.test(el.textContent ?? ''))
    expect(line).toHaveTextContent('Assets ₫256,602,750 · Debts ₫6,850,000')
  })

  it('keeps the note about accounts without a rate', async () => {
    dashServer({ net_worth: 100, assets: 100, debts: 0, net_worth_missing_rates: 1 })
    await renderApp(<Dashboard book={book} />)
    expect(await screen.findByText("1 account has no exchange rate yet, so it isn't counted.")).toBeInTheDocument()
  })
})

describe('hidden amounts (waterflow#104)', () => {
  afterEach(() => localStorage.clear())

  it('shows dots for every amount, the chart\'s axis included', async () => {
    localStorage.setItem('waterflow.hideAmounts', '1')
    dashServer({ net_worth: 249_752_750, spent_this_month: 14_860_000, spent_last_month: 16_240_000, income_this_month: 32_000_000,
      cashflow_6_months: [{ month: '2026-10', spent: 14_860_000, income: 32_000_000, not_converted: 0 }] })
    await renderApp(<Dashboard book={book} />)
    expect((await screen.findAllByText('₫••••')).length).toBeGreaterThanOrEqual(3)
    expect(document.body.textContent).not.toMatch(/\d,\d{3}/)
    expect(document.body.textContent).not.toMatch(/\d+M\b/)
  })
})
