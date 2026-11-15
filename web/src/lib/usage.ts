import { send } from './api'

export type ClientFeature = 'card_pay' | 'hide_amounts' | 'appearance_dark' | 'appearance_light' | 'layout_phone' | 'layout_desktop'

const reported = new Set<string>()

// Tells the server once per feature per UTC day per tab; callers check that usage numbers are on.
export function reportUse(feature: ClientFeature): void {
  const key = `${new Date().toISOString().slice(0, 10)}:${feature}`
  if (reported.has(key)) return
  reported.add(key)
  send('POST', '/v1/usage', { feature }).catch(() => {})
}

export const resetReported = () => reported.clear()
