import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../test/render'
import { AmountField } from './AmountField'

function Field({ signed = false }: { signed?: boolean }) {
  const [value, setValue] = useState('')
  return <AmountField label="Amount" value={value} onChange={setValue} minorUnit={0} signed={signed} />
}

describe('AmountField', () => {
  it('drops a leading zero as the user types on', async () => {
    await renderApp(<Field />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '0')
    expect(input).toHaveValue('0')
    await userEvent.type(input, '99999')
    expect(input).toHaveValue('99,999')
  })

  it("flips the sign with ± where an amount can be below zero, since a phone's number pad has no minus key", async () => {
    await renderApp(<Field signed />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
    expect(input).toHaveValue('-45,000')
    await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
    expect(input).toHaveValue('45,000')
  })

  it('starts a negative amount with ± before any digit, without calling it wrong', async () => {
    await renderApp(<Field signed />)
    await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
    const input = screen.getByLabelText('Amount')
    expect(input).toHaveValue('-')
    expect(input).toHaveAttribute('aria-invalid', 'false')
    await userEvent.type(input, '45000')
    expect(input).toHaveValue('-45,000')
  })

  it('has no ± where the sign comes from elsewhere', async () => {
    await renderApp(<Field />)
    expect(screen.queryByRole('button', { name: 'Change sign' })).not.toBeInTheDocument()
  })
})

describe('with amounts hidden (waterflow#104)', () => {
  afterEach(() => localStorage.clear())

  it('shows dots unless the field has focus: typing shows the number', async () => {
    localStorage.setItem('waterflow.hideAmounts', '1')
    await renderApp(<Field />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '125000')
    expect(input).toHaveValue('125,000')
    await userEvent.tab()
    expect(input).toHaveValue('••••')
    await userEvent.click(input)
    expect(input).toHaveValue('125,000')
  })

  it('keeps an empty field empty', async () => {
    localStorage.setItem('waterflow.hideAmounts', '1')
    await renderApp(<Field />)
    expect(screen.getByLabelText('Amount')).toHaveValue('')
  })
})
