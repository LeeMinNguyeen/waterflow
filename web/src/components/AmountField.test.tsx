import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../test/render'
import { AmountField } from './AmountField'

function Field({ signed = false, unit, minorUnit = 0 }: { signed?: boolean; unit?: string; minorUnit?: number }) {
  const [value, setValue] = useState('')
  return <AmountField label="Amount" value={value} onChange={setValue} minorUnit={minorUnit} signed={signed} unit={unit} />
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

  it('flips the whole of a sum with ± (waterflow#198)', async () => {
    await renderApp(<Field signed />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '50000-8000')
    await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
    expect(input).toHaveValue('-50,000+8,000')
    expect(screen.getByText('= -42,000')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Change sign' }))
    expect(input).toHaveValue('50,000-8,000')
    await userEvent.tab()
    expect(input).toHaveValue('42,000')
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

describe('sums (waterflow#120)', () => {
  it('shows what a sum comes to while typing, and puts the result in the field when it loses focus', async () => {
    await renderApp(<Field unit="VND" />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '45000+100000')
    expect(input).toHaveValue('45,000+100,000')
    expect(screen.getByText('= 145,000 VND')).toBeInTheDocument()
    await userEvent.tab()
    expect(input).toHaveValue('145,000')
    expect(screen.queryByText(/^= /)).not.toBeInTheDocument()
  })

  it("doesn't call a sum wrong while its next number is still to come, only once the field is left", async () => {
    await renderApp(<Field />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '45000+')
    expect(screen.queryByText("The amount isn't in the right format.")).not.toBeInTheDocument()
    await userEvent.tab()
    expect(screen.getByText("The amount isn't in the right format.")).toBeInTheDocument()
    expect(input).toHaveValue('45,000+')
  })

  it('takes a minus after another sign, as a calculator does', async () => {
    await renderApp(<Field />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '50000+-8000')
    expect(input).toHaveValue('50,000+-8,000')
    expect(screen.getByText('= 42,000')).toBeInTheDocument()
    await userEvent.tab()
    expect(input).toHaveValue('42,000')
  })

  it('offers 000, + and − on a touch screen while the field has focus', async () => {
    const matchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('pointer: coarse'), media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      await renderApp(<Field />)
      const input = screen.getByLabelText('Amount')
      expect(screen.queryByRole('button', { name: '000' })).not.toBeInTheDocument()
      await userEvent.type(input, '45')
      await userEvent.click(screen.getByRole('button', { name: '000' }))
      expect(input).toHaveValue('45,000')
      await userEvent.click(screen.getByRole('button', { name: '+' }))
      await userEvent.type(input, '5000')
      expect(input).toHaveValue('45,000+5,000')
      await userEvent.click(screen.getByRole('button', { name: '−' }))
      await userEvent.type(input, '2000')
      expect(input).toHaveValue('45,000+5,000-2,000')
      expect(screen.getByText('= 48,000')).toBeInTheDocument()
      expect(input).toHaveFocus()
    } finally {
      window.matchMedia = matchMedia
    }
  })
})

describe('a long paste', () => {
  it('takes at most 64 characters, far more than any sum, so a huge paste never freezes the tab', async () => {
    await renderApp(<Field />)
    const input = screen.getByLabelText('Amount')
    await userEvent.click(input)
    await userEvent.paste('1+'.repeat(500) + '1')
    expect((input as HTMLInputElement).value.length).toBeLessThanOrEqual(64)
  })
})

describe("a phone's decimal key in the other language's style (review #166)", () => {
  it('takes a dot typed in Vietnamese as the decimal sign for a currency with decimals', async () => {
    await renderApp(<Field minorUnit={2} />, { lang: 'vi' })
    const input = screen.getByRole('textbox')
    await userEvent.type(input, '1250.5')
    expect(input).toHaveValue('1.250,5')
  })

  it('takes a comma typed in English as the decimal point for a currency with decimals', async () => {
    await renderApp(<Field minorUnit={2} />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '12,5+3,25')
    expect(input).toHaveValue('12.5+3.25')
    expect(screen.getByText('= 15.75')).toBeInTheDocument()
  })

  it('refuses a thousands separator typed by habit for a currency with decimals, instead of reading it wrong', async () => {
    await renderApp(<Field minorUnit={2} />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '1,250')
    expect(input).toHaveValue('1.250')
    await userEvent.tab()
    expect(screen.getByText("The amount isn't in the right format.")).toBeInTheDocument()
  })

  it('keeps grouping a number without decimals', async () => {
    await renderApp(<Field />, { lang: 'vi' })
    const input = screen.getByRole('textbox')
    await userEvent.type(input, '50.000')
    expect(input).toHaveValue('50.000')
  })
})
