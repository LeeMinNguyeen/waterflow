import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { session } from '../auth/session'
import en from './en.json'
import vi from './vi.json'

// Two languages. The sign-in language is this browser's (waterflow.language): the screens before sign-in use it, and
// only the language button and Join's dropdown change it. The account's language (users.language) is the app's once
// signed in; it is kept here only while a session is, so a reload opens in it. English when neither is known.
export const languages = ['en', 'vi'] as const
export type Language = (typeof languages)[number]

const SIGN_IN = 'waterflow.language'
const ACCOUNT = 'waterflow.accountLanguage'
const known = (v: string | null | undefined): Language => languages.find((l) => l === v) ?? 'en'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // private mode: the choice lasts until the tab closes
  }
}

function show(lang: Language) {
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

export function setSignInLanguage(lang: Language) {
  write(SIGN_IN, lang)
  show(lang)
}

export function applyAccountLanguage(lang: Language) {
  write(ACCOUNT, lang)
  show(lang)
}

const opening = () => known(session.token() ? read(ACCOUNT) ?? read(SIGN_IN) : read(SIGN_IN))

// Whatever ends the session (Sign out, inactivity, an expired session, another tab, someone else signing in over it)
// goes back to the sign-in language.
let signedInAs = session.token()
session.subscribe(() => {
  const now = session.token()
  if (now === signedInAs) return
  const had = signedInAs
  signedInAs = now
  if (!had) return
  write(ACCOUNT, null)
  show(known(read(SIGN_IN)))
})

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, vi: { translation: vi } },
  lng: opening(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
})
document.documentElement.lang = i18n.language

export const currentLanguage = (): Language => known(i18n.language)

export default i18n
