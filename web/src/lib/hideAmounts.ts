import { createContext, useContext } from 'react'
import { formatMoney } from './money'

const KEY = 'waterflow.hideAmounts'

export function readHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function writeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Storage can be blocked: the choice then lasts until the page reloads.
  }
}

export const HideAmountsContext = createContext<{ hidden: boolean; toggle: () => void }>({ hidden: false, toggle: () => {} })

export const useHideAmounts = () => useContext(HideAmountsContext)

// The number becomes dots; the currency and any sign stay: "₫••••", "•••• ₫", "−₫••••".
export const masked = (text: string) => text.replace(/\d(?:[\d.,\s  ]*\d)?/, '••••')

export function useFormatMoney(): typeof formatMoney {
  const { hidden } = useHideAmounts()
  return hidden ? (...args) => masked(formatMoney(...args)) : formatMoney
}
