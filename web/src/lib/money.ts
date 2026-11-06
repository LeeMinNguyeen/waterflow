// Money is an integer in minor units everywhere (VND 0 decimals, USD 2, KWD 3).
// These helpers never go through floats: parsing works on the digits as text.

export type Locale = 'vi' | 'en'
const intlLocale: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' }

// Separators for the language, read from Intl so typing matches what's shown.
function separators(locale: Locale): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(intlLocale[locale]).formatToParts(1234567.5)
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  }
}

// 125000000 (VND) -> "125.000.000 ₫" in Vietnamese, "₫125,000,000" in English; with sign, "+₫125,000,000".
export function formatMoney(minor: number, currency: string, minorUnit: number, locale: Locale, opts: { sign?: boolean } = {}): string {
  const fmt = new Intl.NumberFormat(intlLocale[locale], {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
    signDisplay: opts.sign ? 'exceptZero' : 'auto',
  })
  // Split into whole and fraction as integers, then let Intl format a decimal
  // string, so no float rounding touches the value.
  const negative = minor < 0
  const abs = Math.abs(minor)
  const scale = 10 ** minorUnit
  const whole = Math.trunc(abs / scale)
  const fraction = String(abs - whole * scale).padStart(minorUnit, '0')
  const text = `${negative ? '-' : ''}${whole}${minorUnit ? `.${fraction}` : ''}`
  return fmt.format(text as unknown as number) // Intl accepts decimal strings exactly
}

export type Tone = 'negative' | 'positive' | 'neutral'
export type AmountKind = 'flow' | 'transfer' | 'balance'

// Colour carries meaning: money out and what's owed are negative, money coming in is positive. A transfer only
// moves money between your own accounts, and a balance above zero is just what you have.
export function amountTone(minor: number, kind: AmountKind = 'flow'): Tone {
  if (kind === 'transfer' || minor === 0) return 'neutral'
  if (minor < 0) return 'negative'
  return kind === 'flow' ? 'positive' : 'neutral'
}

const operators = /([+\-*/×÷])/

// One number as the user wrote it, in minor units, or null unless it has at most minorUnit decimals.
function readNumber(text: string, minorUnit: number, group: string, decimal: string): bigint | null {
  const [whole, fraction = '', extra] = text.replaceAll(group, '').split(decimal)
  if (extra !== undefined || !/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null
  if (whole === '' && fraction === '') return null
  if (fraction.length > minorUnit) return null
  return BigInt((whole || '0') + fraction.padEnd(minorUnit, '0'))
}

type Ratio = { n: bigint; d: bigint }
const add = (a: Ratio, b: Ratio): Ratio => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })

// What the user typed -> minor units, or null. In Vietnamese "." groups thousands, so "1.250" for VND is 1250 and
// "1.250,5" for USD is 125050. A sum is worked out too ("45.000+100.000", "450.000/3"): × and ÷ before + and -, any
// number signed by the + and - in front of it as on a calculator ("50.000+-8.000" is 42.000), exact fractions rounded
// once at the end to the currency's smallest unit, half away from zero.
export function parseAmount(input: string, minorUnit: number, locale: Locale): number | null {
  const { group, decimal } = separators(locale)
  const s = input.replace(/\s/g, '')
  const scale = 10n ** BigInt(minorUnit)
  let total: Ratio = { n: 0n, d: 1n }
  let term: Ratio = { n: 0n, d: 1n }
  let i = 0
  do {
    const op = i === 0 ? '' : s[i++]
    let sign = 1n
    for (; s[i] === '+' || s[i] === '-'; i++) if (s[i] === '-') sign = -sign
    const start = i
    while (i < s.length && !operators.test(s[i])) i++
    const read = readNumber(s.slice(start, i), minorUnit, group, decimal)
    if (read === null) return null
    const value = sign * read
    if (op === '' || op === '+' || op === '-') {
      total = add(total, term)
      term = { n: op === '-' ? -value : value, d: 1n }
    } else if (op === '*' || op === '×') {
      term = { n: term.n * value, d: term.d * scale }
    } else {
      if (read === 0n) return null
      term = { n: sign * term.n * scale, d: term.d * read }
    }
  } while (i < s.length)
  total = add(total, term)
  const abs = total.n < 0n ? -total.n : total.n
  let whole = abs / total.d
  if (2n * (abs % total.d) >= total.d) whole += 1n
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return total.n < 0n ? -Number(whole) : Number(whole)
}

// The other sign of what was typed, keeping it a sum: -(a - b) is -a + b. "" and "-" stay as they are.
export function negated(text: string): string {
  const t = text.trim()
  if (t === '' || t === '-') return text
  const flipped = t.replace(/(?<=[^+\-*/×÷\s]\s*)[+-]/g, (op) => (op === '+' ? '-' : '+'))
  return flipped.startsWith('-') ? flipped.slice(1) : `-${flipped}`
}

function groupNumber(text: string, group: string, decimal: string): string {
  const [, lead, body, trail] = /^(\s*)(.*?)(\s*)$/s.exec(text)!
  const [whole, ...rest] = body.replaceAll(group, '').split(decimal)
  if (!/^\d*$/.test(whole)) return text
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return lead + grouped + (rest.length ? decimal + rest.join(decimal) : '') + trail
}

// Groups thousands while typing, each number of a sum on its own: "45000+100000" -> "45.000+100.000" (vi). Leaves
// what it can't read alone, so the field never fights the user.
export function groupWhileTyping(input: string, locale: Locale): string {
  const { group, decimal } = separators(locale)
  return input.split(operators).map((part, i) => (i % 2 ? part : groupNumber(part, group, decimal))).join('')
}

// Minor units -> the text a user would type, e.g. 125050 USD -> "1.250,50" (vi),
// so an edit form starts from the saved amount.
export function amountText(minor: number, minorUnit: number, locale: Locale): string {
  const { decimal } = separators(locale)
  const abs = Math.abs(minor)
  const scale = 10 ** minorUnit
  const whole = Math.trunc(abs / scale)
  const fraction = String(abs - whole * scale).padStart(minorUnit, '0')
  return groupWhileTyping(`${minor < 0 ? '-' : ''}${whole}${minorUnit ? decimal + fraction : ''}`, locale)
}
