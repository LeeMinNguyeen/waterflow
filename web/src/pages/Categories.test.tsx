import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Book, Budget, Category } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Categories } from './Categories'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const food: Category = { id: 'food', name: 'Food', kind: 'expense', parent_id: null, color: null, archived_at: null, version: 1 }
const all: Budget = { id: 'bu9', category_id: null, excluded_category_ids: [], period: 'monthly', amount: 15_000_000, starts_on: '2026-10-01',
  ends_on: null, version: 1,
  progress: { period_start: '2026-11-01', period_end: '2026-11-30', spent: 600_000, remaining: 14_400_000, percent_used: 4, not_converted: 0 } }

describe('the budget for all spending on Categories (waterflow#122)', () => {
  it('comes first among expenses, with its bar, and opens its budgets', async () => {
    fakeApi({ 'GET /v1/currencies': currencies, 'GET /v1/books/b1/categories': [food], 'GET /v1/books/b1/budgets': [all] })
    await renderApp(<Categories book={book} />)
    const row = await screen.findByRole('button', { name: /^All spending Monthly/ })
    expect(row).toHaveTextContent('All spendingMonthly₫600,000 of ₫15,000,000')
    expect(screen.getAllByRole('button', { name: /All spending|Food/ })[0]).toBe(row)
    await userEvent.click(row)
    expect(await screen.findByRole('heading', { name: 'Budgets · All spending' })).toBeInTheDocument()
  })

  it('is there in a book with no categories at all', async () => {
    fakeApi({ 'GET /v1/currencies': currencies, 'GET /v1/books/b1/categories': [], 'GET /v1/books/b1/budgets': [] })
    await renderApp(<Categories book={book} />)
    await userEvent.click(await screen.findByRole('button', { name: 'All spending Set budget' }))
    expect(await screen.findByRole('heading', { name: 'Budgets · All spending' })).toBeInTheDocument()
  })

  it('offers to set one when there is none', async () => {
    fakeApi({ 'GET /v1/currencies': currencies, 'GET /v1/books/b1/categories': [food], 'GET /v1/books/b1/budgets': [] })
    await renderApp(<Categories book={book} />)
    expect(await screen.findByRole('button', { name: 'All spending Set budget' })).toBeInTheDocument()
  })
})
