import { describe, expect, it } from 'vitest'
import { noPlan, planDates } from './installments'

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
