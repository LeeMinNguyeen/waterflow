import type { InstallmentPlan } from './api'

export type PlanForm = {
  on: boolean
  months: string
  convertedOn: string // '' = the purchase's date
  fee: string
  feeSplit: boolean
  firstStatement: string // '' = the statement the conversion date falls in
  countsTowardLimit: boolean
}

export const noPlan: PlanForm = { on: false, months: '6', convertedOn: '', fee: '', feeSplit: false, firstStatement: '', countsTowardLimit: true }

export const fromPlan = (p: InstallmentPlan, feeText: string): PlanForm => ({
  on: true, months: String(p.months), convertedOn: p.converted_on, fee: feeText, feeSplit: p.fee_split,
  firstStatement: p.first_statement, countsTowardLimit: p.counts_toward_limit,
})

function onDay(year: number, month: number, day: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, last)))
}

// The statement dates from the one `from` falls in (that day included), as the server counts them.
export function statementsFrom(from: string, statementDay: number, count = 3): string[] {
  const d = new Date(`${from}T00:00:00Z`)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + (onDay(d.getUTCFullYear(), d.getUTCMonth(), statementDay) < d ? 1 : 0)
  return Array.from({ length: count }, (_, i) => onDay(year, month + i, statementDay).toISOString().slice(0, 10))
}

export const validMonths = (text: string) => /^\d+$/.test(text) && Number(text) >= 2 && Number(text) <= 60

// The conversion date and first statement the plan fields show, which are also the ones saved: a first statement no
// longer among those offered (the dates changed since) falls back to the first one.
export function planDates(plan: PlanForm, purchaseDate: string, statementDay: number | null) {
  const convertedOn = plan.convertedOn || purchaseDate
  const statements = statementDay && convertedOn ? statementsFrom(convertedOn, statementDay) : []
  const firstStatement = statements.includes(plan.firstStatement) ? plan.firstStatement : statements[0] ?? ''
  return { convertedOn, firstStatement, statements }
}

// A purchase billed on the next statement counts from the day after its own statement closes (within a month of its
// date, as the server asks): `closes` is the statement it lands on.
export function nextStatement(purchaseDate: string, statementDay: number): { postedOn: string; closes: string } {
  const [own, closes] = statementsFrom(purchaseDate, statementDay, 2)
  const after = new Date(`${own}T00:00:00Z`)
  after.setUTCDate(after.getUTCDate() + 1)
  return { postedOn: after.toISOString().slice(0, 10), closes }
}
