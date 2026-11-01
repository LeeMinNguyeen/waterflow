import { afterEach, describe, expect, it, vi } from 'vitest'
import { masked, readHidden, writeHidden } from './hideAmounts'
import { formatMoney } from './money'

describe('hiding amounts (waterflow#104)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('turns the number into dots and keeps the currency and the sign', () => {
    expect(masked(formatMoney(125_000_000, 'VND', 0, 'en'))).toBe('₫••••')
    expect(masked(formatMoney(125_000_000, 'VND', 0, 'vi'))).toBe('•••• ₫')
    expect(masked(formatMoney(-1250, 'USD', 2, 'en'))).toBe('-$••••')
    expect(masked(formatMoney(45_000, 'VND', 0, 'en', { sign: true }))).toBe('+₫••••')
  })

  it('remembers the choice in this browser', () => {
    writeHidden(true)
    expect(readHidden()).toBe(true)
    writeHidden(false)
    expect(readHidden()).toBe(false)
  })

  it('works when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readHidden()).toBe(false)
    expect(() => writeHidden(true)).not.toThrow()
  })
})
