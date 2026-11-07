import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, Book, Transaction } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { todayIn } from '../lib/labels'
import { desktop, renderApp } from '../test/render'
import { Transactions } from './Transactions'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const blank = { last4: null, in_net_worth: true, contact_id: null, note: null, credit_limit: null, annual_fee: null, statement_day: null,
  payment_due_day: null, installment: null, installment_fee: null, interest_rate_bp: null, archived_at: null, version: 1 }
const accounts: Account[] = [
  { ...blank, id: 'cash', name: 'Cash', kind: 'cash', currency: 'VND', balance: 1_250_000 },
  { ...blank, id: 'bank', name: 'Vietcombank', kind: 'checking', currency: 'VND', balance: 18_420_000 },
]
let n = 0
const txn = (on: string, type: Transaction['type'], entries: [string, number][], payee: string | null = null): Transaction => ({
  id: `t${++n}`, type, occurred_on: on, occurred_time: '09:00:00', category_id: null, payee, note: null,
  entries: entries.map(([account_id, amount]) => ({ account_id, amount, currency: 'VND' })), version: 1,
  created_at: '', modified_at: '', created_by: null, modified_by: null, running_balance: null,
})
const items = [
  txn('2025-10-29', 'expense', [['cash', -85_000]], 'Phở Thìn'),
  txn('2025-10-29', 'expense', [['cash', -55_000]], 'Highlands Coffee'),
  txn('2025-10-28', 'transfer', [['bank', -5_000_000], ['cash', 5_000_000]]),
  txn('2025-10-25', 'income', [['bank', 32_000_000]], 'Salary'),
]

function server() {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/transactions': { items, next: null },
    'GET /v1/books/b1/accounts': accounts,
    'GET /v1/books/b1/categories': [],
  })
}

describe('Transactions by day (waterflow#143)', () => {
  beforeEach(() => desktop(true))
  afterEach(() => desktop(false))

  it("groups the rows by day, each day with its total: red when it's money out, green when it's money in", async () => {
    server()
    await renderApp(<Transactions book={book} />)
    const day = await screen.findByRole('region', { name: /29 Oct 2025/ })
    expect(within(day).getByText('Phở Thìn')).toBeInTheDocument()
    expect(within(day).getByText('Highlands Coffee')).toBeInTheDocument()
    expect(within(day).getAllByText('09:00')[0]).toHaveStyle({ color: '#8F8F97' })
    expect(await within(day).findByText('−₫140,000')).toHaveStyle({ color: '#C9372C' })
    const payday = screen.getByRole('region', { name: /25 Oct 2025/ })
    expect(within(payday).getAllByText('+₫32,000,000')[0]).toHaveStyle({ color: '#18803E' })
  })

  it("leaves transfers out of a day's total and shows them without a colour", async () => {
    server()
    await renderApp(<Transactions book={book} />)
    const day = await screen.findByRole('region', { name: /28 Oct 2025/ })
    expect((await within(day).findAllByText(/₫/)).map((e) => e.textContent)).toEqual(['₫5,000,000'])
    expect(within(day).getByText('₫5,000,000')).toHaveStyle({ color: '#18181B' })
  })

  it('filters by account from a chip, kept in the address', async () => {
    server()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions' })
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Vietcombank' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?account_id=bank')
    expect(screen.getByRole('button', { name: 'Account: Vietcombank' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Account: Vietcombank' }).parentElement).toHaveStyle({ height: '36px' })
    await userEvent.click(screen.getByRole('button', { name: 'Clear Account' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/books\/b1\/transactions$/)
  })

  it("names today's group Today, and leaves this year out of the dates", async () => {
    const today = todayIn(book.timezone)
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/transactions': { items: [txn(today, 'expense', [['cash', -85_000]], 'Phở Thìn')], next: null },
      'GET /v1/books/b1/accounts': accounts,
      'GET /v1/books/b1/categories': [],
    })
    await renderApp(<Transactions book={book} />)
    const day = await screen.findByRole('region', { name: /^Today/ })
    expect(day).not.toHaveTextContent(today.slice(0, 4))
  })
})

describe('hidden amounts (waterflow#104)', () => {
  afterEach(() => localStorage.clear())

  it('shows dots for every amount', async () => {
    localStorage.setItem('waterflow.hideAmounts', '1')
    server()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions' })
    expect((await screen.findAllByText(/••••/)).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/\d,\d{3}/)
  })
})

describe("amount and no-category filters, with the list's total (waterflow#103)", () => {
  beforeEach(() => desktop(true))
  afterEach(() => desktop(false))

  const withSummary = (summary = { count: 0, spent: 0, income: 0, net: 0, not_converted: 0 }) => fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/transactions': { items, next: null },
    'GET /v1/books/b1/transactions/summary': summary,
    'GET /v1/books/b1/accounts': accounts,
    'GET /v1/books/b1/categories': [],
  })

  it('filters by amount from and to, kept in the address and sent to the server', async () => {
    const api = withSummary()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions' })
    await userEvent.click(await screen.findByRole('button', { name: 'Amount' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'From' }), '40000')
    await userEvent.type(screen.getByRole('textbox', { name: 'To' }), '600000')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?min=40000&max=600000'))
    await waitFor(() => expect(api.calls.some((c) => c.path === '/v1/books/b1/transactions' && /min=40000&max=600000/.test(c.url))).toBe(true))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Amount: ₫40,000 – ₫600,000' })).toBeInTheDocument()
  })

  it('offers No category first in the category filter', async () => {
    withSummary()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions' })
    await userEvent.click(await screen.findByRole('button', { name: 'Category' }))
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent).slice(0, 2)).toEqual(['All categories', 'No category'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'No category' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?category_id=none')
    expect(screen.getByRole('button', { name: 'Category: No category' })).toBeInTheDocument()
  })

  it("shows the filtered list's count, spending and income, and what a missing rate left out", async () => {
    const api = withSummary({ count: 42, spent: 1_250_000, income: 0, net: -1_250_000, not_converted: 1 })
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions?type=expense' })
    const line = await screen.findByText((_, el) => el?.tagName === 'P' && /^42 transactions/.test(el.textContent ?? ''))
    expect(line).toHaveTextContent('42 transactions · Spent ₫1,250,000 · Income ₫0 · 1 not included')
    expect(api.calls.some((c) => c.path === '/v1/books/b1/transactions/summary' && c.url.includes('type=expense'))).toBe(true)
  })

  it('clears both dates at once', async () => {
    withSummary()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions?from=2025-10-01&to=2025-10-31' })
    await userEvent.click(await screen.findByRole('button', { name: 'Clear Dates' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/books\/b1\/transactions$/)
  })

  it('says in Vietnamese that transactions, not accounts, were left out', async () => {
    withSummary({ count: 3, spent: 30_000, income: 0, net: -30_000, not_converted: 1 })
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions?category_id=none', lang: 'vi' })
    expect(await screen.findByText(/1 giao dịch chưa tính/)).toBeInTheDocument()
  })

  it('keeps an amount typed just before the box closes', async () => {
    withSummary()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions' })
    await userEvent.click(await screen.findByRole('button', { name: 'Amount' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'From' }), '40000')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?min=40000'))
  })

  it('starts the amount afresh when the account picked is in another currency', async () => {
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/transactions': { items, next: null },
      'GET /v1/books/b1/transactions/summary': { count: 0, spent: 0, income: 0, net: 0, not_converted: 0 },
      'GET /v1/books/b1/accounts': [...accounts, { ...blank, id: 'usd', name: 'US bank', kind: 'checking', currency: 'USD', balance: 0 }],
      'GET /v1/books/b1/categories': [],
    })
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions?min=40000' })
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'US bank' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/books\/b1\/transactions\?account_id=usd$/)
  })

  it('shows no total without a filter', async () => {
    const api = withSummary()
    await renderApp(<Transactions book={book} />, { route: '/books/b1/transactions' })
    await screen.findByText('Phở Thìn')
    expect(api.calls.some((c) => c.path.endsWith('/summary'))).toBe(false)
    expect(screen.queryByText(/transactions ·/)).toBeNull()
  })
})

describe('recently deleted (waterflow#119)', () => {
  beforeEach(() => desktop(true))
  afterEach(() => desktop(false))
  const gone = [{ id: 't9', type: 'expense', occurred_on: '2025-10-20', occurred_time: '09:00:00', category_id: null, payee: 'Bánh mì',
    entries: [{ account_id: 'cash', amount: -30_000, currency: 'VND' }], deleted_at: '2025-10-21T02:00:00Z', deleted_by: 'lan' }]
  const deletedServer = () => fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/transactions': { items, next: null },
    'GET /v1/books/b1/transactions/deleted': gone,
    'POST /v1/books/b1/transactions/t9/restore': { ...items[0], id: 't9' },
    'GET /v1/books/b1/accounts': accounts,
    'GET /v1/books/b1/categories': [],
  })

  it("lists the book's recently deleted transactions from the page's menu, each with Restore", async () => {
    const api = deletedServer()
    await renderApp(<Transactions book={book} />)
    await userEvent.click(await screen.findByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Recently deleted' }))
    const list = await screen.findByRole('dialog', { name: 'Recently deleted' })
    const row = await within(list).findByText('Bánh mì')
    expect(row.closest('li')).toHaveTextContent(/Bánh mì.*Cash.*Deleted by lan.*−₫30,000/)
    await userEvent.click(within(list).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(api.writes()).toMatchObject([{ method: 'POST', path: '/v1/books/b1/transactions/t9/restore' }]))
    expect(await screen.findByText('Transaction restored')).toBeInTheDocument()
  })

  it('shows a viewer the list without Restore', async () => {
    deletedServer()
    await renderApp(<Transactions book={{ ...book, role: 'viewer' }} />)
    await userEvent.click(await screen.findByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Recently deleted' }))
    const list = await screen.findByRole('dialog', { name: 'Recently deleted' })
    await within(list).findByText('Bánh mì')
    expect(within(list).queryByRole('button', { name: 'Restore' })).toBeNull()
  })
})
