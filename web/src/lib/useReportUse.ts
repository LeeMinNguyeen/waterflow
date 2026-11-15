import { useCallback } from 'react'
import { useSession } from '../auth/useSession'
import { useInstance } from './queries'
import { reportUse, type ClientFeature } from './usage'

export function useReportUse(): (feature: ClientFeature) => void {
  const on = useInstance().data?.usage_stats === 'on'
  const signedIn = useSession()
  return useCallback((feature) => {
    if (on && signedIn) reportUse(feature)
  }, [on, signedIn])
}
