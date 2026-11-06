import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Book, Transaction } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { phone, renderApp } from '../test/render'
import { TxnDialog } from './TxnDialog'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const cash: Account = {
  id: 'cash', name: 'Cash', kind: 'cash', currency: 'VND', balance: 900_000, last4: null, in_net_worth: true, contact_id: null,
  note: null, credit_limit: null, annual_fee: null, statement_day: null, payment_due_day: null, installment: null,
  installment_fee: null, interest_rate_bp: null, archived_at: null, version: 1,
}
const lunch: Transaction = {
  id: 't1', type: 'expense', occurred_on: '2026-10-03', occurred_time: '08:05:00', category_id: null, payee: 'Phở', note: null,
  entries: [{ account_id: 'cash', amount: -65_000, currency: 'VND' }], version: 2, created_at: '2026-10-03T01:05:00Z',
  modified_at: '2026-10-03T01:05:00Z', created_by: 'lan', modified_by: 'lan', running_balance: null,
}

function server() {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/accounts': [cash],
    'GET /v1/books/b1/categories': [],
    'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
  })
}

describe('people in the account pickers (waterflow#85)', () => {
  it('lists people after the accounts, under "People", and saves a transfer to one', async () => {
    const minh: Account = { ...cash, id: 'minh', name: 'Minh', kind: 'person', contact_id: 'minh', balance: 0 }
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [minh, cash],
      'GET /v1/books/b1/categories': [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Transfer' }))
    await userEvent.type(screen.getByLabelText(/^Amount/), '500000')
    await userEvent.click(screen.getByRole('combobox', { name: /^To account/ }))
    const list = screen.getByRole('listbox')
    expect([...list.children].map((li) => li.textContent?.split(' · ')[0])).toEqual(['Cash', 'People', 'Minh'])
    await userEvent.click(within(list).getByRole('option', { name: /Minh/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ type: 'transfer', entries: [{ account_id: 'cash', amount: -500_000 }, { account_id: 'minh', amount: 500_000 }] })
  })
})

describe('the time of a transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T07:30:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it("starts at the current time in the book's timezone, and is saved with the date", async () => {
    const api = server()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ occurred_on: '2026-10-05', occurred_time: '14:30' })
  })

  it('keeps the saved time when editing', async () => {
    const api = server()
    await renderApp(<TxnDialog book={book} txn={lunch} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ occurred_on: '2026-10-03', occurred_time: '08:05', version: 2 })
  })
})

describe('filling in from my own history (waterflow#65)', () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: 5_000_000 }
  const parking = { id: 'parking', name: 'Parking', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 }
  function history() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash, bank],
      'GET /v1/books/b1/categories': [parking],
      'GET /v1/books/b1/transactions/suggest': { account_id: 'bank', category_id: 'parking', payee: 'Gửi xe' },
    })
  }

  it('fills in the account, category and payee for the amount typed', async () => {
    const api = history()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '5000')
    expect(await screen.findByDisplayValue('Gửi xe', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Parking')
    const asked = api.calls.filter((c) => c.path === '/v1/books/b1/transactions/suggest').at(-1)!
    expect(asked.url).toContain('type=expense')
    expect(asked.url).toContain('amount=5000')
  })

  it('keeps what the user chose', async () => {
    history()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('combobox', { name: /^Account/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Cash/ }))
    await userEvent.type(screen.getByLabelText('Payee'), 'Mine')
    await userEvent.type(screen.getByLabelText(/^Amount/), '5000')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Parking'), { timeout: 3000 })
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Cash')
    expect(screen.getByLabelText('Payee')).toHaveValue('Mine')
  })

  it('fills in the account and category once they load, when the suggestion came first', async () => {
    let release!: () => void
    const late = new Promise<void>((r) => { release = r })
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': async () => { await late; return [cash, bank] },
      'GET /v1/books/b1/categories': async () => { await late; return [parking] },
      'GET /v1/books/b1/transactions/suggest': { account_id: 'bank', category_id: 'parking', payee: 'Gửi xe' },
    })
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '5000')
    expect(await screen.findByDisplayValue('Gửi xe')).toBeInTheDocument()
    release()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Parking'))
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
  })

  it("drops what's left of a suggestion once the amount changes", async () => {
    let release!: () => void
    const late = new Promise<void>((r) => { release = r })
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': async () => { await late; return [cash, bank] },
      'GET /v1/books/b1/categories': async () => { await late; return [parking] },
      'GET /v1/books/b1/transactions/suggest': ({ url }: { url: string }) =>
        url.includes('amount=5000&') ? { account_id: 'bank', category_id: 'parking', payee: 'Gửi xe' } : null,
    })
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount/)
    await userEvent.type(amount, '5000')
    expect(await screen.findByDisplayValue('Gửi xe')).toBeInTheDocument()
    await userEvent.type(amount, '0')
    await waitFor(() => expect(api.calls.some((c) => c.url.includes('amount=50000&'))).toBe(true))
    release()
    await userEvent.click(screen.getByRole('combobox', { name: /^Account/ }))
    await screen.findByRole('option', { name: /Bank/ })
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('combobox', { name: /^Account/ })).not.toHaveTextContent('Bank')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('No category')
  })
})

describe('amounts in a currency of their own (review #166)', () => {
  it('reads the amount in the book currency before an account is picked', async () => {
    const usdBook: Book = { ...book, base_currency: 'USD' }
    const checking: Account = { ...cash, id: 'chk', name: 'Checking', kind: 'checking', currency: 'USD' }
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [{ ...cash, currency: 'USD' }, checking],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/transactions/suggest': null,
    })
    await renderApp(<TxnDialog book={usdBook} txn={null} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount/)
    await userEvent.type(amount, '4.50')
    expect(amount).toHaveAttribute('inputmode', 'decimal')
    expect(amount).toHaveAttribute('aria-invalid', 'false')
  })

  it("never lets a suggestion move the amount to an account in another currency", async () => {
    const card: Account = { ...cash, id: 'usd', name: 'USD card', kind: 'credit_card', currency: 'USD' }
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash, card],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/transactions/suggest': { account_id: 'usd', category_id: null, payee: 'Amazon' },
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '50000')
    expect(await screen.findByDisplayValue('Amazon', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(api.calls.filter((c) => c.path.endsWith('/suggest')).at(-1)!.url).toContain('currency=VND')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'cash', amount: -50_000 }] })
  })

  it("still takes a picked payee's account in another currency while no amount is typed", async () => {
    const card: Account = { ...cash, id: 'usd', name: 'USD card', kind: 'credit_card', currency: 'USD' }
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [cash, { ...cash, id: 'bank', name: 'Bank', kind: 'checking' }, card],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/payees': [{ payee: 'Netflix', count: 3, account_id: 'usd', category_id: null }],
    })
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText('Payee'), 'Net')
    await userEvent.click(await screen.findByRole('option', { name: /Netflix/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('USD card'))
  })

  it("leaves an untouched account alone when the suggestion's is in another currency", async () => {
    const card: Account = { ...cash, id: 'usd', name: 'USD card', kind: 'credit_card', currency: 'USD' }
    const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking' }
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash, bank, card],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/transactions/suggest': { account_id: 'usd', category_id: null, payee: 'Amazon' },
    })
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '50000')
    expect(await screen.findByDisplayValue('Amazon', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /^Account/ })).not.toHaveTextContent('USD card')
  })
})

describe('your usual transactions (waterflow#121)', () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: 5_000_000 }
  const coffee = { id: 'coffee', name: 'Coffee', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 }
  const move = { ...coffee, id: 'move', name: 'Transport' }
  const usualOnes = [
    { account_id: 'bank', category_id: 'coffee', payee: 'Highlands', amount: 55_000, count: 4, last_on: '2026-10-30' },
    { account_id: 'cash', category_id: 'move', payee: null, amount: 45_000, count: 3, last_on: '2026-10-31' },
  ]
  function usual() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [cash, bank],
      'GET /v1/books/b1/categories': [coffee, move],
      'GET /v1/books/b1/transactions/usual': ({ url }: { url: string }) => (url.includes('type=expense') ? usualOnes : []),
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    })
  }

  it('offers them when adding an expense, and picking one fills in the form for a check', async () => {
    const api = usual()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Highlands · ₫55,000' }))
    expect(screen.getByLabelText(/^Amount/)).toHaveValue('55,000')
    expect(screen.getByLabelText('Payee')).toHaveValue('Highlands')
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Coffee')
    expect(api.writes()).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ type: 'expense', category_id: 'coffee', payee: 'Highlands', entries: [{ account_id: 'bank', amount: -55_000 }] })
  })

  it("names one without a payee by its category", async () => {
    usual()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Transport · ₫45,000' })).toBeInTheDocument()
  })

  it('is not offered when editing or for a transfer', async () => {
    const api = usual()
    const { unmount } = await renderApp(<TxnDialog book={book} txn={lunch} onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Save' })
    expect(screen.queryByRole('button', { name: /Highlands ·/ })).not.toBeInTheDocument()
    unmount()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await screen.findByRole('button', { name: /Highlands ·/ })
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    expect(screen.queryByRole('button', { name: /Highlands ·/ })).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.path.endsWith('/usual')).every((c) => !c.url.includes('transfer'))).toBe(true)
  })

  it('offers them on a phone too', async () => {
    phone(true)
    try {
      const api = usual()
      await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
      await userEvent.click(await screen.findByRole('button', { name: 'Highlands · ₫55,000' }))
      expect(screen.getByLabelText('Amount')).toHaveValue('55,000')
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.writes()[0].body).toMatchObject({ payee: 'Highlands', category_id: 'coffee', entries: [{ account_id: 'bank', amount: -55_000 }] }))
    } finally {
      phone(false)
    }
  })
})

describe("the book's payees while typing (waterflow#101)", () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: 5_000_000 }
  const coffee = { id: 'coffee', name: 'Coffee', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 }
  const food = { ...coffee, id: 'food', name: 'Food' }
  const highlands = { payee: 'Highlands', count: 3, account_id: 'bank', category_id: 'coffee' }
  function payees() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [cash, bank],
      'GET /v1/books/b1/categories': [coffee, food],
      'GET /v1/books/b1/payees': ({ url }: { url: string }) =>
        'highlands'.includes((new URL(url, 'http://x').searchParams.get('q') ?? '').toLowerCase()) ? [highlands] : [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
  }

  it('offers them, and picking one fills in its account and category', async () => {
    const api = payees()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '55000')
    await userEvent.type(screen.getByLabelText('Payee'), 'Hi')
    await userEvent.click(await screen.findByRole('option', { name: /Highlands/ }))
    expect(screen.getByLabelText('Payee')).toHaveValue('Highlands')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Coffee'))
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
    expect(api.calls.some((c) => c.url.includes('/payees?') && c.url.includes('type=expense'))).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ payee: 'Highlands', category_id: 'coffee', entries: [{ account_id: 'bank' }] }))
  })

  it('keeps a category the user picked before the payee', async () => {
    payees()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('combobox', { name: 'Category' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Food' }))
    await userEvent.type(screen.getByLabelText('Payee'), 'Hi')
    await userEvent.click(await screen.findByRole('option', { name: /Highlands/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank'))
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Food')
  })

  it("keeps a new payee's name as typed", async () => {
    const api = payees()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '30000')
    await userEvent.type(screen.getByLabelText('Payee'), 'Bánh mì Hồng')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ payee: 'Bánh mì Hồng', entries: [{ account_id: 'cash' }] }))
  })

  it("only renames when editing: the saved account and category stay", async () => {
    const api = payees()
    const saved: Transaction = { ...lunch, payee: 'Phở', category_id: 'food', entries: [{ account_id: 'cash', amount: -65_000, currency: 'VND' }] }
    await renderApp(<TxnDialog book={book} txn={saved} onClose={() => {}} />)
    const payee = await screen.findByLabelText('Payee')
    await userEvent.clear(payee)
    await userEvent.type(payee, 'Hi')
    await userEvent.click(await screen.findByRole('option', { name: /Highlands/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ payee: 'Highlands', category_id: 'food', entries: [{ account_id: 'cash' }] }))
  })

  it('on a phone, lists them in the payee sheet', async () => {
    phone(true)
    try {
      const api = payees()
      await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
      await userEvent.type(await screen.findByLabelText('Amount'), '55000')
      await userEvent.click(screen.getByRole('button', { name: 'Payee' }))
      const sheet = await screen.findByRole('dialog', { name: 'Payee' })
      await userEvent.click(await within(sheet).findByRole('button', { name: /Highlands/ }))
      expect(await screen.findByRole('button', { name: 'Payee: Highlands' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.writes()[0].body).toMatchObject({ payee: 'Highlands', category_id: 'coffee', entries: [{ account_id: 'bank' }] }))
    } finally {
      phone(false)
    }
  })
})

describe('the focus as the dialog opens', () => {
  it('goes to the amount', async () => {
    server()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount/)
    await waitFor(() => expect(amount).toHaveFocus())
  })

  it('stays on a field the user went to before the dialog finished opening', async () => {
    server()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    const payee = await screen.findByLabelText('Payee')
    await userEvent.click(payee)
    await new Promise((r) => setTimeout(r, 500))
    expect(payee).toHaveFocus()
  })
})

describe('picking a category (waterflow#67)', () => {
  it('opens a parent to pick a sub-category, and saves it', async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash],
      'GET /v1/books/b1/categories': [
        { id: 'needs', name: 'Thiết yếu', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 },
        { id: 'moving', name: 'Di chuyển', parent_id: 'needs', kind: 'expense', color: null, archived_at: null, version: 1 },
      ],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '5000')
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show the sub-categories of Thiết yếu' }))
    await userEvent.click(within(screen.getByRole('listbox')).getByText('Di chuyển'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ category_id: 'moving' })
  })
})

describe('paying a card purchase in installments (waterflow#71)', () => {
  const visa: Account = { ...cash, id: 'visa', name: 'Visa', kind: 'credit_card', balance: 0, statement_day: 25, payment_due_day: 10,
    credit_limit: 20_000_000 }
  const laptop: Transaction = { ...lunch, id: 't2', payee: 'Laptop', version: 1,
    entries: [{ account_id: 'visa', amount: -6_000_000, currency: 'VND' }] }
  const plan = { id: 'p1', account_id: 'visa', transaction_id: 't2', payee: 'Laptop', occurred_on: '2026-10-03', amount: 6_000_000,
    months: 6, converted_on: '2026-10-03', first_statement: '2026-10-25', fee: 0, fee_split: false, counts_toward_limit: true,
    ended_on: null, version: 1, installment: 1_000_000, billed: 0, left_to_bill: 6_000_000 }

  function cards(plans: unknown[] = []) {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash, visa],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/installments': plans,
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'PUT /v1/books/b1/transactions/t2': ({ body }: { body: unknown }) => body,
      'POST /v1/books/b1/installments': ({ body }: { body: unknown }) => body,
      'PATCH /v1/books/b1/installments/p1': plan,
      'DELETE /v1/books/b1/installments/p1': undefined,
    })
  }

  it('saves the purchase, then its plan', async () => {
    const api = cards()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'visa' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '6000000')
    await userEvent.click(screen.getByRole('switch', { name: 'Pay in installments' }))
    expect(screen.getByRole('spinbutton', { name: 'Months' })).toHaveValue(6)
    expect(screen.getByText('₫1,000,000').parentElement).toHaveTextContent('6 × ₫1,000,000')
    await userEvent.type(screen.getByLabelText('Conversion fee'), '120000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    const [purchase, created] = api.writes()
    expect(created.path).toBe('/v1/books/b1/installments')
    expect(created.body).toMatchObject({ transaction_id: (purchase.body as { id: string }).id, months: 6, fee: 120_000,
      fee_split: false, counts_toward_limit: true, converted_on: (purchase.body as { occurred_on: string }).occurred_on })
  })

  it('is only offered on a credit card', async () => {
    cards()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await screen.findByLabelText(/^Amount/)
    expect(screen.queryByRole('switch', { name: 'Pay in installments' })).not.toBeInTheDocument()
  })

  it('shows a saved plan and saves what changed', async () => {
    const api = cards([plan])
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    expect(await screen.findByRole('switch', { name: 'Pay in installments' })).toBeChecked()
    const months = screen.getByRole('spinbutton', { name: 'Months' })
    await userEvent.clear(months)
    await userEvent.type(months, '12')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]).toMatchObject({ method: 'PATCH', path: '/v1/books/b1/installments/p1', body: { version: 1, months: 12 } })
  })

  it('removes the plan when the switch is turned off', async () => {
    const api = cards([plan])
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('switch', { name: 'Pay in installments' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]).toMatchObject({ method: 'DELETE', url: '/v1/books/b1/installments/p1?version=1' })
  })

  it('warns that moving the purchase off the card removes its plan', async () => {
    cards([plan])
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    await screen.findByRole('switch', { name: 'Pay in installments' })
    await userEvent.click(screen.getByRole('combobox', { name: /^Account/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Cash/ }))
    expect(screen.getByText("Saving removes this purchase's installment plan.")).toBeInTheDocument()
  })

  it('sends the conversion date and first statement it shows, on a plan added to a saved purchase (review #166)', async () => {
    const api = cards()
    const saved: Transaction = { ...laptop, occurred_on: '2026-10-03' }
    await renderApp(<TxnDialog book={book} txn={saved} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('switch', { name: 'Pay in installments' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]).toMatchObject({ method: 'POST', body: { converted_on: '2026-10-03', first_statement: '2026-10-25' } })
  })

  it("keeps a saved plan when only the purchase changed, even on a card with no statement day now (review #166)", async () => {
    const api = cards([plan])
    api.routes['GET /v1/books/b1/accounts'] = [cash, { ...visa, statement_day: null }]
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText('Note'), 'for work')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].method).toBe('PUT')
  })

  it("after a purchase saved but its plan didn't, a second Save updates that purchase rather than losing the change (review #166)", async () => {
    let refused = true
    const api = cards()
    api.routes['POST /v1/books/b1/installments'] = ({ body }: { body: unknown }) => {
      if (!refused) return body
      refused = false
      return new Response(JSON.stringify({ detail: 'unexpected_error' }), { status: 500 })
    }
    api.routes['POST /v1/books/b1/transactions'] = ({ body }: { body: unknown }) => ({ ...(body as object), version: 1, entries: (body as { entries: unknown[] }).entries.map((e) => ({ ...(e as object), currency: 'VND' })) })
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'visa' }} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount/)
    await userEvent.type(amount, '6000000')
    await userEvent.click(screen.getByRole('switch', { name: 'Pay in installments' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    const id = (api.writes()[0].body as { id: string }).id
    api.routes[`PUT /v1/books/b1/transactions/${id}`] = ({ body }: { body: unknown }) => body
    await userEvent.clear(screen.getByLabelText(/^Amount/))
    await userEvent.type(screen.getByLabelText(/^Amount/), '7000000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(4))
    expect(api.writes()[2]).toMatchObject({ method: 'PUT', path: `/v1/books/b1/transactions/${id}`,
      body: { version: 1, entries: [{ account_id: 'visa', amount: -7_000_000 }] } })
    expect(api.writes()[3]).toMatchObject({ method: 'POST', path: '/v1/books/b1/installments', body: { transaction_id: id } })
  })
})

describe('after saving', () => {
  it('closes and says it was saved', async () => {
    server()
    const onClose = vi.fn()
    await renderApp(<TxnDialog book={book} txn={null} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Transaction saved')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open with the error when the save fails', async () => {
    const api = server()
    api.routes['POST /v1/books/b1/transactions'] = new Response(JSON.stringify({ detail: 'invalid' }), { status: 422 })
    const onClose = vi.fn()
    await renderApp(<TxnDialog book={book} txn={null} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Transaction saved')).not.toBeInTheDocument()
  })
})

describe('the type switch (waterflow#143)', () => {
  it('keeps refund and adjustment under More, and shows the one picked', async () => {
    const api = server()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Expense' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Refund' }))
    expect(screen.getByRole('button', { name: 'Refund' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Expense' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.type(screen.getByLabelText(/^Amount/), '189000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ type: 'refund', entries: [{ account_id: 'cash', amount: 189_000 }] }))
  })
})

describe("adding on a phone, the owner's concept (waterflow#143)", () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Vietcombank', kind: 'checking', balance: 18_420_000 }
  const cat = (id: string, name: string, parent_id: string | null = null, kind: 'expense' | 'income' = 'expense') =>
    ({ id, parent_id, name, kind, color: '#D97757', archived_at: null, version: 1 })
  const categories = [cat('fun', 'Đi chơi'), cat('party', 'Tiệc', 'fun'), cat('bar', 'Bar', 'fun'), cat('move', 'Di chuyển'), cat('pay', 'Lương', null, 'income')]
  const books: Book[] = [book, { ...book, id: 'b2', name: 'Gia đình' }, { ...book, id: 'b3', name: 'Shared, read only', role: 'viewer' }]

  function phoneServer() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': books,
      'GET /v1/books/b1/accounts': [cash, bank],
      'GET /v1/books/b1/categories': categories,
      'GET /v1/books/b2/accounts': [{ ...cash, id: 'home', name: 'Quỹ chung' }, { ...bank, id: 'acb', name: 'ACB' }],
      'GET /v1/books/b2/categories': [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'POST /v1/books/b2/transactions': ({ body }: { body: unknown }) => body,
    })
  }
  beforeEach(() => phone(true))
  afterEach(() => phone(false))

  it('takes the amount, a category pill and an account from its sheet, and saves from the button at the bottom', async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Expense' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.type(screen.getByLabelText('Amount'), '45000')
    expect(screen.getByText('−')).toHaveStyle({ color: '#C9372C' })
    await userEvent.click(screen.getByRole('button', { name: 'Di chuyển' }))
    expect(screen.getByRole('button', { name: 'Di chuyển' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: /^Account/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    await userEvent.click(within(sheet).getByText('Vietcombank'))
    expect(await screen.findByRole('button', { name: /^Account/ })).toHaveTextContent('Vietcombank')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ type: 'expense', category_id: 'move', entries: [{ account_id: 'bank', amount: -45_000 }] }))
  })

  it("opens a category's sub-categories from its ••• badge, and the pill then shows the one picked", async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Đi chơi' }))
    await userEvent.click(screen.getByRole('button', { name: 'Sub-categories of Đi chơi' }))
    const sheet = await screen.findByRole('dialog', { name: 'Đi chơi' })
    await userEvent.click(within(sheet).getByText('Bar'))
    expect(await screen.findByRole('button', { name: 'Bar' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.type(screen.getByLabelText('Amount'), '120000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ category_id: 'bar' }))
  })

  it('finds any category under All, with a search', async () => {
    phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'All' }))
    const sheet = await screen.findByRole('dialog', { name: 'Category' })
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Search categories' }), 'tiệ')
    expect(within(sheet).queryByText('Di chuyển')).not.toBeInTheDocument()
    await userEvent.click(within(sheet).getByText(/Tiệc/))
    expect(await screen.findByRole('button', { name: 'Tiệc' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves an expense as a refund with the Refund tick', async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText('Amount'), '189000')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Refund' }))
    expect(screen.getByText('+')).toHaveStyle({ color: '#18803E' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ type: 'refund', entries: [{ account_id: 'cash', amount: 189_000 }] }))
  })

  it('sets the payee from its chip', async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText('Amount'), '85000')
    await userEvent.click(screen.getByRole('button', { name: 'Payee' }))
    const sheet = await screen.findByRole('dialog', { name: 'Payee' })
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Payee' }), 'Phở Thìn')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('button', { name: 'Payee: Phở Thìn' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].body).toMatchObject({ payee: 'Phở Thìn' }))
  })

  it('adds into another book picked from the top, keeping the amount; books it can only view are left out', async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText('Amount'), '300000')
    await userEvent.click(screen.getByRole('button', { name: 'Book: Personal' }))
    const sheet = await screen.findByRole('dialog', { name: 'Switch book' })
    expect(within(sheet).queryByText('Shared, read only')).not.toBeInTheDocument()
    await userEvent.click(within(sheet).getByText('Gia đình'))
    expect(await screen.findByRole('button', { name: 'Book: Gia đình' })).toBeInTheDocument()
    expect(screen.getByLabelText('Amount')).toHaveValue('300,000')
    await userEvent.click(screen.getByRole('button', { name: /^Account/ }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Account' })).getByText('ACB'))
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0].path).toBe('/v1/books/b2/transactions'))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'acb', amount: -300_000 }] })
  })

  it('keeps edit history and delete in the ⋮ menu when editing', async () => {
    phoneServer()
    await renderApp(<TxnDialog book={book} txn={lunch} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /^Book:/ })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Edit history' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })
})

describe('the desktop dialog, as designed (waterflow#143)', () => {
  it('closes from the × in its title row', async () => {
    server()
    let closed = false
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => { closed = true }} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(closed).toBe(true)
  })
})

describe('the sign of an amount (waterflow#137)', () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: -5_000_000 }
  const opening: Transaction = { ...lunch, type: 'opening_balance', payee: null, entries: [{ account_id: 'bank', amount: -5_000_000, currency: 'VND' }] }
  const adjustment: Transaction = { ...lunch, type: 'adjustment', payee: null, entries: [{ account_id: 'bank', amount: -30_000, currency: 'VND' }] }
  function bankServer() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [bank],
      'GET /v1/books/b1/categories': [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
  }

  it('shows the minus of an opening balance, and keeps it when saved unchanged', async () => {
    const api = bankServer()
    await renderApp(<TxnDialog book={book} txn={opening} onClose={() => {}} />)
    expect(await screen.findByLabelText(/^Amount/)).toHaveValue('-5,000,000')
    expect(screen.getByText('Below zero: what the account owed.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ type: 'opening_balance', entries: [{ account_id: 'bank', amount: -5_000_000 }] })
  })

  it('saves a minus typed on an opening balance', async () => {
    const api = bankServer()
    await renderApp(<TxnDialog book={book} txn={opening} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount/)
    await waitFor(() => expect(amount).toBeEnabled())
    await userEvent.clear(amount)
    await userEvent.type(amount, '-200000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'bank', amount: -200_000 }] })
  })

  it('refuses a minus on an expense, and says why', async () => {
    const api = bankServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'bank' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '-45000')
    expect(screen.getByText('The type says which way the money goes: no minus needed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.writes()).toHaveLength(0)
  })

  it("shows a loan's opening debt as the amount owed, as the account form does, and saves it as a debt", async () => {
    const loan: Account = { ...bank, id: 'loan', name: 'Loan', kind: 'loan' }
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [loan],
      'GET /v1/books/b1/categories': [],
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
    const owed: Transaction = { ...opening, entries: [{ account_id: 'loan', amount: -5_000_000, currency: 'VND' }] }
    await renderApp(<TxnDialog book={book} txn={owed} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount owed/)
    await waitFor(() => expect(amount).toHaveValue('5,000,000'))
    await userEvent.clear(amount)
    await userEvent.type(amount, '6000000')
    expect(amount).toHaveValue('6,000,000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'loan', amount: -6_000_000 }] })
  })

  it("saves a loan's opening debt typed as a sum as the whole debt (waterflow#120)", async () => {
    const loan: Account = { ...bank, id: 'loan', name: 'Loan', kind: 'loan' }
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [loan],
      'GET /v1/books/b1/categories': [],
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
    const owed: Transaction = { ...opening, entries: [{ account_id: 'loan', amount: -5_000_000, currency: 'VND' }] }
    await renderApp(<TxnDialog book={book} txn={owed} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount owed/)
    await waitFor(() => expect(amount).toHaveValue('5,000,000'))
    await userEvent.clear(amount)
    await userEvent.type(amount, '4000000+2000000{Enter}')
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'loan', amount: -6_000_000 }] })
  })

  it('waits for the accounts before an opening balance can be typed, since they decide its sign', async () => {
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': () => new Promise(() => {}),
      'GET /v1/books/b1/categories': [],
    })
    await renderApp(<TxnDialog book={book} txn={opening} onClose={() => {}} />)
    expect(await screen.findByLabelText(/^Amount/)).toBeDisabled()
  })

  it('refuses a minus in the amount received, and says why', async () => {
    const usd: Account = { ...cash, id: 'usd', name: 'Dollars', currency: 'USD', balance: 50_00 }
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [bank, usd],
      'GET /v1/books/b1/categories': [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'bank' }} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Transfer' }))
    await userEvent.type(screen.getByLabelText(/^Amount/), '100000')
    await userEvent.click(screen.getByRole('combobox', { name: /^To account/ }))
    await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Dollars/ }))
    await userEvent.type(screen.getByLabelText(/^Amount received/), '-4')
    expect(screen.getByText('The type says which way the money goes: no minus needed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.writes()).toHaveLength(0)
  })

  it('keeps the minus of an adjustment, as before', async () => {
    const api = bankServer()
    await renderApp(<TxnDialog book={book} txn={adjustment} onClose={() => {}} />)
    expect(await screen.findByLabelText(/^Amount/)).toHaveValue('-30,000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ type: 'adjustment', entries: [{ account_id: 'bank', amount: -30_000 }] })
  })
})

describe('the sign of an amount on a phone (waterflow#137)', () => {
  const loan: Account = { ...cash, id: 'loan', name: 'Loan', kind: 'loan', balance: -5_000_000 }
  const owed: Transaction = { ...lunch, type: 'opening_balance', payee: null, entries: [{ account_id: 'loan', amount: -5_000_000, currency: 'VND' }] }
  function phoneServer() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [cash, loan],
      'GET /v1/books/b1/categories': [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
  }
  beforeEach(() => phone(true))
  afterEach(() => phone(false))

  it("shows a loan's opening debt as the amount owed, and saves it as a debt", async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={owed} onClose={() => {}} />)
    const amount = await screen.findByLabelText('Amount owed')
    await waitFor(() => expect(amount).toHaveValue('5,000,000'))
    expect(screen.getByText('Amount owed')).toBeInTheDocument()
    await userEvent.clear(amount)
    await userEvent.type(amount, '6000000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'loan', amount: -6_000_000 }] })
  })

  it("keeps the minus of a bank account's opening balance", async () => {
    const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: -5_000_000 }
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [bank],
      'GET /v1/books/b1/categories': [],
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
    const opening: Transaction = { ...owed, entries: [{ account_id: 'bank', amount: -5_000_000, currency: 'VND' }] }
    await renderApp(<TxnDialog book={book} txn={opening} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('-5,000,000'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'bank', amount: -5_000_000 }] })
  })

  it('refuses a minus on an expense, and says why', async () => {
    const api = phoneServer()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText('Amount'), '-45000')
    expect(screen.getByText('The type says which way the money goes: no minus needed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.writes()).toHaveLength(0)
  })
})

describe('a ± button where an amount can be below zero (waterflow#155)', () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: -5_000_000 }
  const loan: Account = { ...cash, id: 'loan', name: 'Loan', kind: 'loan', balance: -5_000_000 }
  const adjustment: Transaction = { ...lunch, type: 'adjustment', payee: null, entries: [{ account_id: 'bank', amount: 30_000, currency: 'VND' }] }
  const opening: Transaction = { ...lunch, type: 'opening_balance', payee: null, entries: [{ account_id: 'bank', amount: 5_000_000, currency: 'VND' }] }
  function bankServer() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [bank, loan],
      'GET /v1/books/b1/categories': [],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
    })
  }

  it('turns an adjustment negative', async () => {
    const api = bankServer()
    await renderApp(<TxnDialog book={book} txn={adjustment} onClose={() => {}} />)
    const amount = await screen.findByLabelText(/^Amount/)
    await waitFor(() => expect(amount).toHaveValue('30,000'))
    await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
    expect(amount).toHaveValue('-30,000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ type: 'adjustment', entries: [{ account_id: 'bank', amount: -30_000 }] })
  })

  it("is on a bank account's opening balance, not on a loan's amount owed or an expense", async () => {
    bankServer()
    const { unmount } = await renderApp(<TxnDialog book={book} txn={opening} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText(/^Amount/)).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Change sign' })).toBeEnabled()
    unmount()
    const owed: Transaction = { ...opening, entries: [{ account_id: 'loan', amount: -5_000_000, currency: 'VND' }] }
    const second = await renderApp(<TxnDialog book={book} txn={owed} onClose={() => {}} />)
    await screen.findByLabelText(/^Amount owed/)
    expect(screen.queryByRole('button', { name: 'Change sign' })).not.toBeInTheDocument()
    second.unmount()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'bank' }} onClose={() => {}} />)
    await screen.findByLabelText(/^Amount/)
    expect(screen.queryByRole('button', { name: 'Change sign' })).not.toBeInTheDocument()
  })

  it("turns a bank account's opening balance negative on a phone", async () => {
    phone(true)
    try {
      const api = bankServer()
      await renderApp(<TxnDialog book={book} txn={opening} onClose={() => {}} />)
      const amount = await screen.findByLabelText('Amount')
      await waitFor(() => expect(amount).toBeEnabled())
      await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
      expect(amount).toHaveValue('-5,000,000')
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.writes()).toHaveLength(1))
      expect(api.writes()[0].body).toMatchObject({ entries: [{ account_id: 'bank', amount: -5_000_000 }] })
    } finally {
      phone(false)
    }
  })
})

describe('duplicating, and saving to add another (waterflow#102)', () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: 5_000_000 }
  const visa: Account = { ...cash, id: 'visa', name: 'Visa', kind: 'credit_card', balance: 0, statement_day: 25, payment_due_day: 10,
    credit_limit: 20_000_000 }
  const coffee = { id: 'coffee', name: 'Coffee', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 }
  const latte: Transaction = { ...lunch, category_id: 'coffee', payee: 'Highlands', note: 'with Minh',
    entries: [{ account_id: 'bank', amount: -55_000, currency: 'VND' }] }
  const laptop: Transaction = { ...lunch, id: 't2', payee: 'Laptop', entries: [{ account_id: 'visa', amount: -6_000_000, currency: 'VND' }] }
  const plan = { id: 'p1', account_id: 'visa', transaction_id: 't2', payee: 'Laptop', occurred_on: '2026-10-03', amount: 6_000_000,
    months: 6, converted_on: '2026-10-03', first_statement: '2026-10-25', fee: 0, fee_split: false, counts_toward_limit: true,
    ended_on: null, version: 1, installment: 1_000_000, billed: 0, left_to_bill: 6_000_000 }
  function cafe() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/accounts': [cash, bank, visa],
      'GET /v1/books/b1/categories': [coffee],
      'GET /v1/books/b1/installments': [plan],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'POST /v1/books/b1/installments': ({ body }: { body: unknown }) => body,
    })
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T07:30:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('duplicates a transaction as a new one with the same details, dated now', async () => {
    const api = cafe()
    await renderApp(<TxnDialog book={book} txn={latte} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicate' }))
    expect(await screen.findByText('Add transaction')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/^Amount/)).toHaveValue('55,000'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    const [copy] = api.writes()
    expect(copy.method).toBe('POST')
    expect(copy.body).toMatchObject({ type: 'expense', occurred_on: '2026-10-05', occurred_time: '14:30', category_id: 'coffee',
      payee: 'Highlands', note: 'with Minh', entries: [{ account_id: 'bank', amount: -55_000 }] })
    expect((copy.body as { id: string }).id).not.toBe(latte.id)
  })

  it('keeps what it copied when a suggestion for the amount comes back', async () => {
    const api = cafe()
    const food = { ...coffee, id: 'food', name: 'Food' }
    api.routes['GET /v1/books/b1/categories'] = [coffee, food]
    api.routes['GET /v1/books/b1/transactions/suggest'] = { account_id: 'cash', category_id: 'food', payee: 'Phở 24' }
    await renderApp(<TxnDialog book={book} txn={latte} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(api.calls.some((c) => c.path === '/v1/books/b1/transactions/suggest')).toBe(true))
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.getByLabelText('Payee')).toHaveValue('Highlands')
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Coffee')
  })

  it("doesn't copy a card purchase's installment plan", async () => {
    const api = cafe()
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    expect(await screen.findByRole('switch', { name: 'Pay in installments' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(await screen.findByRole('switch', { name: 'Pay in installments' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].path).toBe('/v1/books/b1/transactions')
  })

  it('is not offered on an opening balance or an adjustment, or to a viewer', async () => {
    cafe()
    for (const [txn, b] of [[{ ...latte, type: 'adjustment', category_id: null }, book], [{ ...latte, type: 'opening_balance', category_id: null }, book],
      [latte, { ...book, role: 'viewer' }]] as [Transaction, Book][]) {
      const { unmount } = await renderApp(<TxnDialog book={b} txn={txn} onClose={() => {}} />)
      await screen.findByRole('button', { name: 'Edit history' })
      expect(screen.queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('saves and starts another, keeping the type, account and date and clearing the rest', async () => {
    const api = cafe()
    const onClose = vi.fn()
    await renderApp(<TxnDialog book={book} txn={null} onClose={onClose} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Income' }))
    await userEvent.click(screen.getByRole('combobox', { name: /^Account/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Bank/ }))
    await userEvent.type(screen.getByLabelText(/^Amount/), '45000')
    await userEvent.type(screen.getByLabelText('Payee'), 'Mẹ')
    await userEvent.type(screen.getByLabelText('Note'), 'tiền chợ')
    await userEvent.click(screen.getByRole('button', { name: 'Save and add another' }))
    expect(await screen.findByText('Transaction saved')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    const amount = screen.getByLabelText(/^Amount/)
    await waitFor(() => expect(amount).toHaveValue(''))
    expect(amount).toHaveFocus()
    expect(screen.getByLabelText('Payee')).toHaveValue('')
    expect(screen.getByLabelText('Note')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Income' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
    await userEvent.type(amount, '30000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    const [first, second] = api.writes().map((w) => w.body as { id: string; occurred_on: string })
    expect(second).toMatchObject({ type: 'income', occurred_on: first.occurred_on, payee: null, note: null,
      entries: [{ account_id: 'bank', amount: 30_000 }] })
    expect(second.id).not.toBe(first.id)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('on a phone, duplicates from the ⋮ menu and offers Save and add another', async () => {
    phone(true)
    try {
      const api = cafe()
      await renderApp(<TxnDialog book={book} txn={latte} onClose={() => {}} />)
      await userEvent.click(await screen.findByRole('button', { name: 'More actions' }))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
      expect(await screen.findByRole('button', { name: 'Book: Personal' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save and add another' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.writes()).toHaveLength(1))
      expect(api.writes()[0].body).toMatchObject({ payee: 'Highlands', entries: [{ account_id: 'bank', amount: -55_000 }] })
    } finally {
      phone(false)
    }
  })
})

describe('the amount on a phone (waterflow#161)', () => {
  beforeEach(() => phone(true))
  afterEach(() => phone(false))

  it('has no box around it while typing, only the line under its row', async () => {
    server()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    const amount = await screen.findByLabelText('Amount')
    await userEvent.type(amount, '45000')
    expect(amount).toHaveFocus()
    const outline = amount.closest('.MuiOutlinedInput-root')!.querySelector('.MuiOutlinedInput-notchedOutline')!
    expect(outline).toHaveStyle({ borderWidth: '0px' })
  })
})
