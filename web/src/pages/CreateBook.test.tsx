import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { session } from '../auth/session'
import type { Book } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { CreateBook } from './CreateBook'

const personal: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'UTC', role: 'owner', archived_at: null, version: 1 }

function server(books: Book[]) {
  return fakeApi({ 'GET /v1/books': books, 'GET /v1/me/book-invites': [], 'GET /v1/currencies': currencies })
}

describe('Create a book (waterflow#21)', () => {
  it('has Cancel, back to the page before, when the user already has a book', async () => {
    server([personal])
    await renderApp(<CreateBook />, { history: ['/books/b1/accounts', { pathname: '/books/new', state: { fromApp: true } }] })
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/accounts')
  })

  it('goes to the first book when it was opened directly', async () => {
    server([personal])
    await renderApp(<CreateBook />, { route: '/books/new' })
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/) // "/" opens the first book
  })

  it('stays in the app when "/" sent the user here and a book turned up since (an invite accepted)', async () => {
    server([personal])
    // The entry before is another site's: "/" replaced itself with this page.
    await renderApp(<CreateBook />, { history: ['/elsewhere', '/books/new'] })
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })

  it('has no Cancel for a first book: there is nowhere to go back to', async () => {
    const api = server([])
    await renderApp(<CreateBook />, { route: '/books/new' })
    await screen.findByRole('button', { name: /create/i })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls.some((c) => c.path === '/v1/books')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('has Sign out for someone with no book yet, who has no other way out on a shared computer (review #166)', async () => {
    const api = server([])
    api.routes['POST /v1/auth/sign-out'] = undefined
    await renderApp(<CreateBook />, { route: '/books/new' })
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(session.token()).toBeNull())
    expect(api.writes().map((c) => c.path)).toEqual(['/v1/auth/sign-out'])
  })
})
