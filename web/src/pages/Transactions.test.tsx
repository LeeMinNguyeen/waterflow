import { screen, within } from '@testing-library/react'
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
