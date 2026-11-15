import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { session } from '../auth/session'
import { fakeApi } from '../test/fakeApi'
import { reportUse, resetReported } from './usage'

const sent = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === '/v1/usage').map((c) => c.body)

beforeEach(() => resetReported())
afterEach(() => vi.useRealTimers())

describe('reporting a use (waterflow#229)', () => {
  it('sends each feature once a day', () => {
    const api = fakeApi({ 'POST /v1/usage': undefined })
    reportUse('card_pay')
    reportUse('card_pay')
    reportUse('hide_amounts')
    expect(sent(api)).toEqual([{ feature: 'card_pay' }, { feature: 'hide_amounts' }])
  })

  it('sends again for whoever signs in next on this tab', () => {
    const api = fakeApi({ 'POST /v1/usage': undefined })
    reportUse('layout_phone')
    session.set('someone-else')
    reportUse('layout_phone')
    expect(sent(api)).toHaveLength(2)
  })

  it('sends again on a new UTC day', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeApi({ 'POST /v1/usage': undefined })
    vi.setSystemTime(new Date('2026-11-10T23:59:00Z'))
    reportUse('card_pay')
    vi.setSystemTime(new Date('2026-11-11T00:01:00Z'))
    reportUse('card_pay')
    expect(sent(api)).toHaveLength(2)
  })

  it('swallows a refused request', async () => {
    const api = fakeApi({ 'POST /v1/usage': new Response(JSON.stringify({ detail: 'unknown_feature' }), { status: 422 }) })
    expect(() => reportUse('card_pay')).not.toThrow()
    await vi.waitFor(() => expect(sent(api)).toHaveLength(1))
  })

  it('swallows a network failure', async () => {
    fakeApi({})
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    reportUse('card_pay')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})
