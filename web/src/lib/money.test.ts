import { describe, expect, it } from 'vitest'
import { amountText, amountTone, formatMoney, groupWhileTyping, negated, parseAmount, typedDecimal } from './money'

const nbsp = (s: string) => s.replace(/[  ]/g, ' ')

describe('formatMoney', () => {
  it('formats by language and the currency decimals', () => {
    expect(nbsp(formatMoney(1_250_000, 'VND', 0, 'vi'))).toBe('1.250.000 ₫')
    expect(nbsp(formatMoney(1_250_000, 'VND', 0, 'en'))).toBe('₫1,250,000')
    expect(formatMoney(-45000, 'USD', 2, 'en')).toBe('-$450.00')
    expect(formatMoney(1234, 'KWD', 3, 'en').replace(/\s/g, ' ')).toContain('1.234')
  })

  it('keeps amounts too large for float cents exact', () => {
    expect(formatMoney(900_719_925_474_099, 'USD', 2, 'en')).toBe('$9,007,199,254,740.99')
  })
})

describe('parseAmount', () => {
  it('reads Vietnamese grouping', () => {
    expect(parseAmount('1.250', 0, 'vi')).toBe(1250)
    expect(parseAmount('1.250.000', 0, 'vi')).toBe(1_250_000)
    expect(parseAmount('1.250,5', 2, 'vi')).toBe(125_050)
  })

  it('reads English grouping', () => {
    expect(parseAmount('1,250.05', 2, 'en')).toBe(125_005)
    expect(parseAmount('-450', 2, 'en')).toBe(-45_000)
    expect(parseAmount('.5', 2, 'en')).toBe(50)
  })

  it('refuses what it cannot read exactly', () => {
    expect(parseAmount('1,5', 0, 'vi')).toBeNull() // VND has no decimals
    expect(parseAmount('1.234', 2, 'en')).toBeNull() // three decimals for USD
    expect(parseAmount('abc', 2, 'en')).toBeNull()
    expect(parseAmount('', 2, 'en')).toBeNull()
    expect(parseAmount('1.2.3', 2, 'en')).toBeNull()
  })
})

describe('groupWhileTyping', () => {
  it('groups the whole part as the user types', () => {
    expect(groupWhileTyping('1250000', 'vi')).toBe('1.250.000')
    expect(groupWhileTyping('1250000,5', 'vi')).toBe('1.250.000,5')
    expect(groupWhileTyping('-1250', 'en')).toBe('-1,250')
    expect(groupWhileTyping('12a', 'en')).toBe('12a')
  })

  it('drops leading zeros but keeps a zero before the decimals', () => {
    expect(groupWhileTyping('099999', 'en')).toBe('99,999')
    expect(groupWhileTyping('09', 'vi')).toBe('9')
    expect(groupWhileTyping('000', 'en')).toBe('0')
    expect(groupWhileTyping('0', 'en')).toBe('0')
    expect(groupWhileTyping('0.5', 'en')).toBe('0.5')
    expect(groupWhileTyping('0,5', 'vi')).toBe('0,5')
    expect(groupWhileTyping('-05', 'en')).toBe('-5')
    expect(groupWhileTyping('0.050', 'en')).toBe('0.050')
  })
})

describe('amountText', () => {
  it('turns minor units back into what parseAmount reads', () => {
    expect(amountText(125050, 2, 'vi')).toBe('1.250,50')
    expect(amountText(-1_250_000, 0, 'vi')).toBe('-1.250.000')
    expect(amountText(5, 2, 'en')).toBe('0.05')
    for (const [minor, unit] of [[125050, 2], [-7, 3], [1_000_000, 0]] as const) {
      expect(parseAmount(amountText(minor, unit, 'vi'), unit, 'vi')).toBe(minor)
      expect(parseAmount(amountText(minor, unit, 'en'), unit, 'en')).toBe(minor)
    }
  })
})

describe('formatMoney with a sign (waterflow#143)', () => {
  it('shows + on money in and - on money out, nothing on zero', () => {
    expect(nbsp(formatMoney(189_000, 'VND', 0, 'en', { sign: true }))).toBe('+₫189,000')
    expect(nbsp(formatMoney(-85_000, 'VND', 0, 'vi', { sign: true }))).toBe('-85.000 ₫')
    expect(nbsp(formatMoney(0, 'VND', 0, 'en', { sign: true }))).toBe('₫0')
  })
})

describe('amountTone (waterflow#143)', () => {
  it('makes money out negative and money in positive', () => {
    expect(amountTone(-85_000)).toBe('negative')
    expect(amountTone(32_000_000)).toBe('positive')
    expect(amountTone(0)).toBe('neutral')
  })

  it('keeps transfers neutral, whichever way they go', () => {
    expect(amountTone(-5_000_000, 'transfer')).toBe('neutral')
    expect(amountTone(5_000_000, 'transfer')).toBe('neutral')
  })

  it('marks only a negative balance', () => {
    expect(amountTone(-6_850_000, 'balance')).toBe('negative')
    expect(amountTone(120_000_000, 'balance')).toBe('neutral')
  })
})

describe('sums in an amount (waterflow#120)', () => {
  it('works out what was typed, in the language\'s separators', () => {
    expect(parseAmount('45.000+100.000', 0, 'vi')).toBe(145_000)
    expect(parseAmount('45000 + 100000', 0, 'vi')).toBe(145_000)
    expect(parseAmount('45,000 + 100,000', 0, 'en')).toBe(145_000)
    expect(parseAmount('120.000-35.000', 0, 'vi')).toBe(85_000)
    expect(parseAmount('450.000/3', 0, 'vi')).toBe(150_000)
    expect(parseAmount('3*25.000', 0, 'vi')).toBe(75_000)
    expect(parseAmount('3×25.000', 0, 'vi')).toBe(75_000)
    expect(parseAmount('100.000÷4', 0, 'vi')).toBe(25_000)
    expect(parseAmount('10.5*2', 2, 'en')).toBe(2_100)
    expect(parseAmount('12,5+0,25', 2, 'vi')).toBe(1_275)
  })

  it('multiplies and divides before adding and subtracting', () => {
    expect(parseAmount('2+3*4', 0, 'en')).toBe(14)
    expect(parseAmount('20-8/4', 0, 'en')).toBe(18)
    expect(parseAmount('2+3*4', 2, 'en')).toBe(1_400)
  })

  it('rounds what doesn\'t come out even to the currency\'s smallest unit, half away from zero', () => {
    expect(parseAmount('1.000.000/3', 0, 'vi')).toBe(333_333)
    expect(parseAmount('10/4', 0, 'en')).toBe(3)
    expect(parseAmount('1/2', 0, 'en')).toBe(1)
    expect(parseAmount('-1/2', 0, 'en')).toBe(-1)
    expect(parseAmount('10/3', 2, 'en')).toBe(333)
    expect(parseAmount('0.1+0.2', 2, 'en')).toBe(30)
  })

  it('reads a leading minus as a negative number', () => {
    expect(parseAmount('-50.000', 0, 'vi')).toBe(-50_000)
    expect(parseAmount('-50.000+10.000', 0, 'vi')).toBe(-40_000)
    expect(parseAmount('10.000-50.000', 0, 'vi')).toBe(-40_000)
  })

  it('reads a + or - in front of any number, as a calculator does', () => {
    expect(parseAmount('50.000+-8000', 0, 'vi')).toBe(42_000)
    expect(parseAmount('50.000+-8.000', 0, 'vi')).toBe(42_000)
    expect(parseAmount('50.000-+8.000', 0, 'vi')).toBe(42_000)
    expect(parseAmount('50.000--8.000', 0, 'vi')).toBe(58_000)
    expect(parseAmount('50,000 + -8,000', 0, 'en')).toBe(42_000)
    expect(parseAmount('1++2', 0, 'en')).toBe(3)
    expect(parseAmount('+45000', 0, 'en')).toBe(45_000)
    expect(parseAmount('--5', 0, 'en')).toBe(5)
    expect(parseAmount('5*-2', 0, 'en')).toBe(-10)
    expect(parseAmount('-5*-2', 0, 'en')).toBe(10)
    expect(parseAmount('10.000÷-4', 0, 'vi')).toBe(-2_500)
    expect(parseAmount('1/-2', 0, 'en')).toBe(-1)
    expect(parseAmount('-1/-2', 0, 'en')).toBe(1)
    expect(parseAmount('100/-3', 0, 'en')).toBe(-33)
    expect(parseAmount('12,5*-2', 2, 'vi')).toBe(-2_500)
    expect(parseAmount('20-8/-4', 0, 'en')).toBe(22)
  })

  it('refuses shorthand, x for times, and anything that isn\'t a whole sum', () => {
    for (const text of ['45k', '1tr2', '1,2tr', '3x25000', '45000+', '45000+-', '-', '+-', '*3', '5**2', '5*/2', '5-*3', '5/0', '5/-0',
      '1.000/0,0', '(1+2)*3', '1.234+1', '2^3']) {
      expect(parseAmount(text, text === '1.234+1' ? 2 : 0, text.includes(',') ? 'vi' : 'en'), text).toBeNull()
    }
  })

  it('keeps a total too large to be exact out', () => {
    expect(parseAmount('9007199254740991*10', 0, 'en')).toBeNull()
  })

  it('groups each number of a sum while typing', () => {
    expect(groupWhileTyping('45000+100000', 'vi')).toBe('45.000+100.000')
    expect(groupWhileTyping('45000 + 100000', 'en')).toBe('45,000 + 100,000')
    expect(groupWhileTyping('-1250000-250000', 'vi')).toBe('-1.250.000-250.000')
    expect(groupWhileTyping('1250.5*2', 'en')).toBe('1,250.5*2')
    expect(groupWhileTyping('45000+', 'vi')).toBe('45.000+')
  })
})

describe('the other sign of what was typed (waterflow#198)', () => {
  it('flips a whole sum, so it works out to the same amount with the other sign', () => {
    for (const [text, locale, minor] of [['45.000', 'vi', 0], ['-45.000', 'vi', 0], ['50.000-8.000', 'vi', 0], ['45,000 + 100,000', 'en', 0],
      ['2+3*4', 'en', 0], ['20-8/4', 'en', 0], ['50.000+-8.000', 'vi', 0], ['50.000--8.000', 'vi', 0], ['+45000', 'en', 0], ['--5', 'en', 0],
      ['5*-2', 'en', 0], ['-1/2', 'en', 0], ['12,5-0,25', 'vi', 2]] as const) {
      const value = parseAmount(text, minor, locale)
      expect(parseAmount(negated(text), minor, locale), text).toBe(-value!)
      expect(parseAmount(negated(negated(text)), minor, locale), text).toBe(value)
    }
    expect(negated('50.000-8.000')).toBe('-50.000+8.000')
    expect(negated('-50.000+8.000')).toBe('50.000-8.000')
  })

  it('leaves nothing and a lone minus as they are', () => {
    expect(negated('')).toBe('')
    expect(negated('-')).toBe('-')
  })
})

describe("a phone's decimal key in the other language's style (review #166)", () => {
  it('reads a separator typed on its own as the decimal sign, for a currency with decimals', () => {
    expect(typedDecimal('12', '12.', 3, 2, 'vi')).toBe('12,')
    expect(typedDecimal('12', '12,', 3, 2, 'en')).toBe('12.')
    expect(typedDecimal('1.250', '1.250.', 6, 2, 'vi')).toBe('1.250,')
    expect(typedDecimal('12,5+3', '12,5+3.', 7, 2, 'vi')).toBe('12,5+3,')
    expect(typedDecimal('1250', '12.50', 3, 2, 'vi')).toBe('12,50')
    expect(typedDecimal('12345', '12.5', 3, 2, 'vi')).toBe('12,5')
  })

  it("leaves the language's own decimal sign, a currency without decimals, a second decimal and a paste as they are", () => {
    expect(typedDecimal('12', '12,', 3, 2, 'vi')).toBe('12,')
    expect(typedDecimal('12', '12.', 3, 0, 'vi')).toBe('12.')
    expect(typedDecimal('12,5', '12,5.', 5, 2, 'vi')).toBe('12,5.')
    expect(typedDecimal('', '12.5', 4, 2, 'vi')).toBe('12.5')
    expect(typedDecimal('12', '12.', 3, 2, 'en')).toBe('12.')
  })
})
