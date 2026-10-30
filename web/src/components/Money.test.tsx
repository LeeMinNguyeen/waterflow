import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Money } from './Money'

describe('Money (waterflow#143)', () => {
  it('writes a negative amount with a minus sign, as the design does, in both languages', async () => {
    fakeApi({ 'GET /v1/currencies': currencies })
    await renderApp(<Money amount={-85_000} currency="VND" />, { lang: 'vi' })
    expect((await screen.findByText(/85\.000/)).textContent?.replace(/\s/g, ' ')).toBe('−85.000 ₫')
  })

  it('shows money out in red and money in in green, with their signs', async () => {
    fakeApi({ 'GET /v1/currencies': currencies })
    await renderApp(<><Money amount={-85_000} currency="VND" sign /><Money amount={189_000} currency="VND" sign /></>)
    expect(await screen.findByText('−₫85,000')).toHaveStyle({ color: '#C9372C' })
    expect(screen.getByText('+₫189,000')).toHaveStyle({ color: '#18803E' })
  })

  it('keeps a transfer and a positive balance in the text colour, and a debt red', async () => {
    fakeApi({ 'GET /v1/currencies': currencies })
    await renderApp(
      <>
        <Money amount={-5_000_000} currency="VND" kind="transfer" />
        <Money amount={120_000_000} currency="VND" kind="balance" />
        <Money amount={-125_050} currency="USD" kind="balance" />
      </>,
    )
    expect(await screen.findByText('₫5,000,000')).toHaveStyle({ color: '#18181B' })
    expect(screen.getByText('₫120,000,000')).toHaveStyle({ color: '#18181B' })
    expect(screen.getByText('−$1,250.50')).toHaveStyle({ color: '#C9372C' })
  })
})
