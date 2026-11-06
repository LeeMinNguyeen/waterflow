import { useMemo, useState, type ReactNode } from 'react'
import { HideAmountsContext, readHidden, writeHidden } from '../lib/hideAmounts'

export function HideAmountsProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(readHidden)
  const value = useMemo(() => ({
    hidden,
    toggle: () => {
      writeHidden(!hidden)
      setHidden(!hidden)
    },
  }), [hidden])
  return <HideAmountsContext.Provider value={value}>{children}</HideAmountsContext.Provider>
}
