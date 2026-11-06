import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Book } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { BookSettings } from './BookSettings'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }

function server(patch: unknown) {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books': [book],
    'GET /v1/books/b1/members': [],
    'GET /v1/books/b1/changes': { marker: 'm1' },
    'PATCH /v1/books/b1': patch,
  })
}
const name = () => screen.getByRole('textbox', { name: /^Book name/ })

describe('book settings once the book reloads with a new version (review #166)', () => {
  it('still says Saved.', async () => {
    server({ ...book, name: 'Home', version: 2 })
    const { rerender } = await renderApp(<BookSettings book={book} />)
    await userEvent.clear(name())
    await userEvent.type(name(), 'Home')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    rerender(<BookSettings book={{ ...book, name: 'Home', version: 2 }} />)
    expect(screen.getByText('Saved.')).toBeInTheDocument()
  })

  it('after a 409 shows the book as it is now, and keeps saying why', async () => {
    server(new Response(JSON.stringify({ detail: 'conflict' }), { status: 409 }))
    const { rerender } = await renderApp(<BookSettings book={book} />)
    await userEvent.clear(name())
    await userEvent.type(name(), 'Mine')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument()
    rerender(<BookSettings book={{ ...book, name: 'Theirs', version: 2 }} />)
    await waitFor(() => expect(name()).toHaveValue('Theirs'))
    expect(screen.getByText(/changed somewhere else/)).toBeInTheDocument()
  })
})

describe('members (review #166)', () => {
  it("names each member's role select after the member", async () => {
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/members': [
        { user_id: 'u1', name: 'lan', display_name: null, role: 'owner', pending: false, me: true },
        { user_id: 'u2', name: 'bob', display_name: null, role: 'editor', pending: false, me: false },
      ],
    })
    await renderApp(<BookSettings book={book} />)
    expect(await screen.findByRole('combobox', { name: /bob/ })).toBeInTheDocument()
  })
})

describe('the look (review #166)', () => {
  it('has one filled button, a page title like the other pages, and 36 px controls in the member rows', async () => {
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books': [book],
      'GET /v1/books/b1/members': [
        { user_id: 'u1', name: 'lan', display_name: null, role: 'owner', pending: false, me: true },
        { user_id: 'u2', name: 'bob', display_name: null, role: 'editor', pending: false, me: false },
      ],
    })
    const { container } = await renderApp(<BookSettings book={book} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Book settings' })).toBeInTheDocument()
    await screen.findByRole('combobox', { name: /bob/ })
    expect(container.querySelectorAll('.MuiButton-contained.MuiButton-colorPrimary')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveStyle({ height: '36px' })
  })
})
