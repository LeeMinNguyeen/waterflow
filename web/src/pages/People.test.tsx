import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Book, Contact } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { People } from './People'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const minh: Contact = { id: 'minh', name: 'Minh', note: null, archived_at: null, version: 1, currency: 'VND',
  balances: [{ currency: 'VND', owed_to_you: 0, you_owe: 150_000 }] }

describe('people are accounts (waterflow#85)', () => {
  it('shows who owes whom, and opens their transactions', async () => {
    fakeApi({ 'GET /v1/currencies': currencies, 'GET /v1/books/b1/contacts': [minh] })
    await renderApp(<People book={book} />)
    expect(await screen.findByText(/You owe ₫150,000/)).toBeInTheDocument()
    await userEvent.click(screen.getByText('Minh'))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?account_id=minh')
  })

  it('adds a person in the currency picked for their account, the book’s by default', async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/contacts': [],
      'POST /v1/books/b1/contacts': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<People book={book} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add person' }))
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Bob')
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('VND · Vietnamese Dong')
    await userEvent.click(screen.getByRole('combobox', { name: 'Currency' }))
    await userEvent.click(await screen.findByRole('option', { name: /USD/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ name: 'Bob', currency: 'USD' })
  })
})

describe('a person someone else changed first (review #166)', () => {
  it('shows them as they are now, says so, and saves from there', async () => {
    let onServer = minh
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/contacts': () => [onServer],
      'PATCH /v1/books/b1/contacts/minh': ({ body }: { body: unknown }) => {
        const b = body as { version: number; name: string }
        if (b.version !== onServer.version) return new Response(JSON.stringify({ detail: 'conflict' }), { status: 409 })
        onServer = { ...onServer, name: b.name, version: onServer.version + 1 }
        return onServer
      },
    })
    await renderApp(<People book={book} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit person' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit person' }))
    onServer = { ...minh, name: 'Minh Anh', version: 2 }
    const name = screen.getByRole('textbox', { name: /^Name/ })
    await userEvent.clear(name)
    await userEvent.type(name, 'Minh B')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Minh Anh'))
    await userEvent.clear(screen.getByRole('textbox', { name: /^Name/ }))
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Minh B')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes().at(-1)!.body).toMatchObject({ version: 2, name: 'Minh B' }))
    await waitFor(() => expect(onServer.name).toBe('Minh B'))
  })

  it("leaves what the user is typing alone when the list refetches with someone else's change", async () => {
    let onServer = minh
    fakeApi({ 'GET /v1/currencies': currencies, 'GET /v1/books/b1/contacts': () => [onServer] })
    const { client } = await renderApp(<People book={book} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit person' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit person' }))
    await userEvent.clear(screen.getByRole('textbox', { name: /^Name/ }))
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Minh B')
    onServer = { ...minh, note: 'neighbour', version: 2 }
    await act(() => client.invalidateQueries({ queryKey: ['books', 'b1', 'contacts'] }))
    await waitFor(() => expect(client.getQueryData<Contact[]>(['books', 'b1', 'contacts', true])?.[0].version).toBe(2))
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Minh B')
  })
})
