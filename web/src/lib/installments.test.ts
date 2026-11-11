import { describe, expect, it } from 'vitest'
import { noPlan, planDates, nextStatement } from './installments'

describe('the dates a plan shows are the ones it saves (review #166)', () => {
  it('starts at the purchase date and the statement it falls in', () => {
    expect(planDates(noPlan, '2026-10-03', 25)).toMatchObject({ convertedOn: '2026-10-03', firstStatement: '2026-10-25' })
  })

  it('follows a new conversion date, and a first statement no longer offered falls back to the first one', () => {
    const plan = { ...noPlan, convertedOn: '2026-10-28', firstStatement: '2026-10-25' }
    expect(planDates(plan, '2026-10-03', 25)).toMatchObject({ convertedOn: '2026-10-28', firstStatement: '2026-11-25' })
  })

  it('keeps a first statement picked from those offered', () => {
    expect(planDates({ ...noPlan, firstStatement: '2026-11-25' }, '2026-10-03', 25).firstStatement).toBe('2026-11-25')
  })
})

describe('billing a purchase on the next statement', () => {
  it('posts it the day after its own statement closes, onto the one after', () => {
    expect(nextStatement('2026-10-24', 25)).toEqual({ postedOn: '2026-10-26', closes: '2026-11-25' })
    expect(nextStatement('2026-10-25', 25)).toEqual({ postedOn: '2026-10-26', closes: '2026-11-25' })
    expect(nextStatement('2026-10-26', 25)).toEqual({ postedOn: '2026-11-26', closes: '2026-12-25' })
    expect(nextStatement('2027-01-30', 31)).toEqual({ postedOn: '2027-02-01', closes: '2027-02-28' })
    expect(nextStatement('2026-12-31', 31)).toEqual({ postedOn: '2027-01-01', closes: '2027-01-31' })
  })
})
