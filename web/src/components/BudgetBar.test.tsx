import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/render'
import { BudgetBar } from './BudgetBar'

describe('a budget bar', () => {
  it('keeps room for its label beside long amounts, which go under it when the row is too narrow (waterflow#211)', async () => {
    await renderApp(<BudgetBar label="Mỗi tháng" spent={12_945_000} budget={15_000_000} percent={86} format={(n) => `${n} ₫`} />)
    const label = screen.getByText('Mỗi tháng')
    expect(label).toHaveStyle({ minWidth: '48px' })
    expect(label.parentElement).toHaveStyle({ flexWrap: 'wrap' })
    expect(screen.getByText('12945000 ₫ of 15000000 ₫')).toHaveStyle({ marginLeft: 'auto' })
  })
})
