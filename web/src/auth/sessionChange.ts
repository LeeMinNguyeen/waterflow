import type { QueryClient } from '@tanstack/react-query'
import { updating } from '../lib/updating'
import { session } from './session'

// When a session ends or someone else signs in over it (a reset link opened on a shared computer), nothing of the
// person before stays: not their cached data, nor an update they started.
export function forgetOnSessionChange(client: QueryClient): () => void {
  let last = session.token()
  return session.subscribe(() => {
    const now = session.token()
    if (now === last) return
    const had = last
    last = now
    if (!had) return
    client.clear()
    updating.clear()
  })
}
