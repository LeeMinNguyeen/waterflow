import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Book, Budget, Category } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { BudgetDialog } from './BudgetDialog'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const food: Category = { id: 'food', name: 'Food', kind: 'expense', parent_id: null, color: null, archived_at: null, version: 1 }

describe('BudgetDialog', () => {
  it('saves from the button bar, then closes and says so', async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/budgets': [],
      'POST /v1/books/b1/budgets': ({ body }: { body: unknown }) => body,
    })
    const onClose = vi.fn()
    await renderApp(<BudgetDialog book={book} category={food} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText(/^Limit/), '3000000')
    const bar = screen.getByRole('button', { name: 'Cancel' }).parentElement!
    await userEvent.click(within(bar).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ category_id: 'food', period: 'monthly', amount: 3_000_000 })
    expect(await screen.findByText('Budget added')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('changing a budget (waterflow#139)', () => {
  const monthly: Budget = { id: 'bu1', category_id: 'food', period: 'monthly', amount: 1_500_000, starts_on: '2026-10-01', ends_on: null,
    version: 3, progress: { period_start: '2026-11-01', period_end: '2026-11-30', spent: 600_000, remaining: 900_000, percent_used: 40, not_converted: 0 } }
  // The server's copy: a PATCH changes it, as the API does.
  function budgetServer(start: Budget, patch?: (body: Record<string, unknown>) => unknown) {
    let current = start
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/budgets': () => [current],
      'PATCH /v1/books/b1/budgets/bu1': ({ body }: { body: unknown }) => {
        const b = body as Record<string, unknown>
        if (patch) return patch(b)
        current = { ...current, amount: (b.amount as number) ?? current.amount, starts_on: (b.starts_on as string) ?? current.starts_on,
          ends_on: b.ongoing ? null : (b.ends_on as string) ?? current.ends_on, version: current.version + 1 }
        return current
      },
    })
  }

  it('changes the limit, sending the version it was shown with; the list then shows the new limit', async () => {
    const api = budgetServer(monthly)
    await renderApp(<BudgetDialog book={book} category={food} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budget' }))
    const limit = screen.getByLabelText(/^Limit/)
    expect(limit).toHaveValue('1,500,000')
    await userEvent.clear(limit)
    await userEvent.type(limit, '2000000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: '/v1/books/b1/budgets/bu1',
      body: { version: 3, amount: 2_000_000, starts_on: '2026-10-01', ongoing: true } })
    expect(await screen.findByText('₫600,000 of ₫2,000,000')).toBeInTheDocument()
    expect(screen.getByText('Budget saved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit budget' })).toBeEnabled()   // the change is closed
  })

  it('makes a budget with an end date ongoing when the end date is cleared', async () => {
    const api = budgetServer({ ...monthly, ends_on: '2026-12-31' })
    await renderApp(<BudgetDialog book={book} category={food} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budget' }))
    const ends = screen.getByRole('group', { name: /^Ends/ })
    await userEvent.click(within(ends.closest('.MuiFormControl-root') as HTMLElement).getByRole('button', { name: /clear/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ version: 3, ongoing: true })
    expect(api.writes()[0].body).not.toHaveProperty('ends_on')
  })

  it('says when someone else changed it first, and shows it as it is now', async () => {
    const api = budgetServer(monthly, () => new Response(JSON.stringify({ detail: 'conflict' }), { status: 409 }))
    api.routes['GET /v1/books/b1/budgets'] = [monthly]
    await renderApp(<BudgetDialog book={book} category={food} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budget' }))
    api.routes['GET /v1/books/b1/budgets'] = [{ ...monthly, amount: 1_800_000, version: 4 }]
    await userEvent.clear(screen.getByLabelText(/^Limit/))
    await userEvent.type(screen.getByLabelText(/^Limit/), '2000000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument()
    expect(await screen.findByText('₫600,000 of ₫1,800,000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit budget' })).toBeEnabled()   // the change is closed
  })

  it('a viewer sees the budgets, and can neither change, delete nor add one', async () => {
    budgetServer(monthly)
    await renderApp(<BudgetDialog book={{ ...book, role: 'viewer' }} category={food} onClose={() => {}} />)
    expect(await screen.findByText('₫600,000 of ₫1,500,000')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete budget' })).not.toBeInTheDocument()
    expect(screen.queryByText('Add budget')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
