import { describe, expect, it } from 'vitest'
import { theme } from './theme'

type Palette = {
  background: { default: string; sidebar: string }
  primary: { main: string }
  success: { main: string }
  error: { main: string }
  divider: string
  chart: { spending: string; income: string }
}
const { light, dark } = (theme as unknown as { colorSchemes: Record<'light' | 'dark', { palette: Palette }> }).colorSchemes

describe('theme (waterflow#22)', () => {
  it('has a sidebar colour one shade darker than the page, in light and dark', () => {
    const level = (hex: string) => parseInt(hex.slice(1, 3), 16)
    expect(level(light.palette.background.sidebar)).toBeLessThan(level(light.palette.background.default))
    expect(level(dark.palette.background.sidebar)).toBeLessThan(level(dark.palette.background.default))
  })
})

describe('the minimal design (waterflow#143)', () => {
  it('uses its colours in light and dark', () => {
    expect([light.palette.background.default, light.palette.primary.main, light.palette.success.main, light.palette.error.main])
      .toEqual(['#FFFFFF', '#2E6BE6', '#18803E', '#C9372C'])
    expect([dark.palette.background.default, dark.palette.primary.main, dark.palette.success.main, dark.palette.error.main])
      .toEqual(['#121214', '#7AA3FF', '#5CC685', '#F27F74'])
    expect([light.palette.divider, dark.palette.divider]).toEqual(['#ECECE9', '#25252A'])
  })

  it('draws spending and income bars that differ in lightness, the other way round in dark', () => {
    expect(light.palette.chart).toEqual({ spending: '#D9534A', income: '#8ACB9F' })
    expect(dark.palette.chart).toEqual({ spending: '#EE8076', income: '#2C7A4D' })
  })

  it('sets Inter first', () => {
    expect(String(theme.typography.fontFamily)).toMatch(/^"?Inter/)
  })

  it('puts field labels above the field', () => {
    expect(theme.components?.MuiInputLabel?.defaultProps?.shrink).toBe(true)
    expect(theme.components?.MuiOutlinedInput?.defaultProps?.notched).toBe(false)
  })
})
