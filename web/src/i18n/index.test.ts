import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshI18n() {
  vi.resetModules()
  return (await import('./index')).default
}

describe('the language a page opens in', () => {
  afterEach(() => localStorage.clear())

  it('is the one this browser remembers, before sign-in too', async () => {
    localStorage.setItem('waterflow.language', 'vi')
    expect((await freshI18n()).language).toBe('vi')
    expect(document.documentElement.lang).toBe('vi')
  })

  it('is English when this browser remembers none, or one the app does not have', async () => {
    expect((await freshI18n()).language).toBe('en')
    localStorage.setItem('waterflow.language', 'xx')
    expect((await freshI18n()).language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it("is the account's language while signed in, remembered so a reload opens in it", async () => {
    localStorage.setItem('waterflow.language', 'en')
    localStorage.setItem('waterflow.session', 'token')
    localStorage.setItem('waterflow.accountLanguage', 'vi')
    expect((await freshI18n()).language).toBe('vi')
  })

  it("is the sign-in language without a session, whatever account language was left behind", async () => {
    localStorage.setItem('waterflow.language', 'en')
    localStorage.setItem('waterflow.accountLanguage', 'vi')
    expect((await freshI18n()).language).toBe('en')
  })

  it('goes back to the sign-in language when someone else signs in over a session (review #166)', async () => {
    localStorage.setItem('waterflow.language', 'en')
    localStorage.setItem('waterflow.session', 'alice')
    localStorage.setItem('waterflow.accountLanguage', 'vi')
    const i18n = await freshI18n()
    const { session } = await import('../auth/session')
    expect(i18n.language).toBe('vi')
    session.set('bob')
    expect(i18n.language).toBe('en')
    expect(localStorage.getItem('waterflow.accountLanguage')).toBeNull()
  })
})
