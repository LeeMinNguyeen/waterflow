import { QueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { updating, useUpdating } from '../lib/updating'
import { session } from './session'
import { forgetOnSessionChange } from './sessionChange'

describe("nothing of one person's stays for the next (review #166)", () => {
  let stop = () => {}
  afterEach(() => {
    stop()
    session.set(null)
  })

  it('forgets the cached data when someone else signs in over a session, as a reset link does', () => {
    const client = new QueryClient()
    session.set('alice')
    client.setQueryData(['me'], { username: 'alice' })
    stop = forgetOnSessionChange(client)
    session.set('bob')
    expect(client.getQueryData(['me'])).toBeUndefined()
  })

  it('forgets it on signing out too, and keeps it when nothing changed', () => {
    const client = new QueryClient()
    session.set('alice')
    stop = forgetOnSessionChange(client)
    client.setQueryData(['me'], { username: 'alice' })
    session.set('alice')
    expect(client.getQueryData(['me'])).toEqual({ username: 'alice' })
    session.set(null)
    expect(client.getQueryData(['me'])).toBeUndefined()
  })

  it("drops an update the admin started, so the next person doesn't see its notice", () => {
    session.set('admin')
    stop = forgetOnSessionChange(new QueryClient())
    const { result } = renderHook(() => useUpdating())
    act(() => updating.start('0.5.0'))
    expect(result.current).not.toBeNull()
    act(() => session.set(null))
    expect(result.current).toBeNull()
  })
})
