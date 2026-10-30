import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Bar } from '../components/Bar'
import { BudgetBar } from '../components/BudgetBar'
import { CashflowChart } from '../components/charts/CashflowChart'
import { useChartColors } from '../components/charts/palette'
import { useErrorText } from '../components/errors'
import { Money } from '../components/Money'
import { PageHeader, Section, SeeAll } from '../components/Page'
import { useOpenTxn } from '../components/txnContext'
import { currentLanguage } from '../i18n'
import { api, type Book, type Transaction } from '../lib/api'
import { shiftDay, todayIn } from '../lib/labels'
import { formatMoney } from '../lib/money'
import { useCategories, useCurrencies, useDashboard } from '../lib/queries'

// Credits some rate sources ask for (backend/app/jobs/fx_update.py); a proper name, not translated.
const RATE_CREDITS: Record<string, { label: string; href: string }> = {
  'open.er-api.com': { label: 'Rates By Exchange Rate API', href: 'https://www.exchangerate-api.com' },
}

function Stat({ label, value, note, big = false }: { label: string; value: ReactNode; note?: ReactNode; big?: boolean }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="textSecondary">{label}</Typography>
      <Typography variant={big ? 'display' : 'h1'} component="p"
        sx={{ mt: 0.75, fontVariantNumeric: 'tabular-nums', ...(!big && { fontSize: { xs: 18, md: 24 }, lineHeight: { xs: '24px', md: '32px' } }) }}>
        {value}
      </Typography>
      {note && <Typography variant="caption" color="textDisabled" component="p" sx={{ mt: 0.5 }}>{note}</Typography>}
    </Box>
  )
}

const rowSx = {
  px: 0, py: 0.75, minHeight: 52, gap: 1.5, '& .MuiListItemText-root': { my: 0 },
  '&:not(:first-of-type)': { borderTop: 1, borderColor: 'divider' },
} as const

function Dot({ color }: { color?: string | null }) {
  return <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: color || 'text.disabled' }} />
}

// The six month starts ending with the book's current month, YYYY-MM-01.
function lastSixMonths(today: string): string[] {
  const [y, m] = today.split('-').map(Number)
  return Array.from({ length: 6 }, (_, i) => {
    const n = y * 12 + (m - 1) - (5 - i)
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`
  })
}

// Everything from one API call, in the book's currency.
export function Dashboard({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const navigate = useNavigate()
  const openTxn = useOpenTxn()
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const chartColors = useChartColors()
  const dash = useDashboard(book.id)
  const categories = useCategories(book.id, true)
  const currencies = useCurrencies()
  const minor = (c: string) => currencies.data?.get(c)?.minor_unit ?? 0
  const money = (amount: number, currency = book.base_currency) => formatMoney(amount, currency, minor(currency), lang)
  const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
  const axis = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short' })
  const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' })

  if (dash.isPending) return null
  if (!dash.data) return <Alert severity="error">{errorText(dash.error)}</Alert>
  const d = dash.data

  const months = lastSixMonths(todayIn(book.timezone))
  const byMonth = new Map(d.cashflow_6_months.map((m) => [m.month, m]))
  const cashflow = months.map((month) => ({ month, spent: byMonth.get(month)?.spent ?? 0, income: byMonth.get(month)?.income ?? 0 }))
  const notConverted = d.cashflow_6_months.reduce((n, m) => n + m.not_converted, 0)

  // Roll sub-categories into their top-level category.
  const parentOf = new Map((categories.data ?? []).map((c) => [c.id, c.parent_id]))
  const nameOf = new Map((categories.data ?? []).map((c) => [c.id, c.name]))
  const colorOf = new Map((categories.data ?? []).map((c) => [c.id, c.color]))
  const top = (id: string | null) => {
    let cur = id
    while (cur && parentOf.get(cur)) cur = parentOf.get(cur)!
    return cur
  }
  const rolled = new Map<string, { id: string | null; spent: number }>()
  for (const c of d.top_categories_this_month) {
    const id = top(c.category_id)
    const key = id ?? 'none'
    rolled.set(key, { id, spent: (rolled.get(key)?.spent ?? 0) + c.spent })
  }
  const bars = [...rolled.values()].sort((a, b) => b.spent - a.spent).slice(0, desktop ? 6 : 3)
  const barMax = Math.max(1, ...bars.map((b) => b.spent))

  async function openRecent(id: string) {
    openTxn(await api<Transaction>(`/v1/books/${book.id}/transactions/${id}`))
  }

  // Recent transactions carry their category's name only: its colour, when that name means one colour.
  const colorsByName = new Map<string, Set<string | null>>()
  for (const c of categories.data ?? []) colorsByName.set(c.name, (colorsByName.get(c.name) ?? new Set()).add(c.color))
  const colorNamed = (name: string | null) => {
    const found = name ? colorsByName.get(name) : undefined
    return found?.size === 1 ? [...found][0] : null
  }

  const own = d.accounts.filter((a) => a.kind !== 'person')
  const empty = own.length === 0
  const pinned = own.filter((a) => a.pinned)
  const shownAccounts = (pinned.length ? pinned : own).slice(0, 5)
  // The open exchange rate source's terms ask for this credit wherever its rates are used.
  const converts = d.accounts.some((a) => a.currency !== book.base_currency)
  const credit = converts ? RATE_CREDITS[d.rates_source ?? ''] : undefined
  const thisMonth = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(`${months[5]}T00:00:00`))
  const seeAll = (to: string) => <SeeAll to={`/books/${book.id}${to}`}>{t('dash.seeAll')}</SeeAll>
  const today = todayIn(book.timezone)
  const when = (on: string) =>
    on === today ? t('txn.today') : on === shiftDay(today, -1) ? t('txn.yesterday') : dayFmt.format(new Date(`${on}T00:00:00`))
  const legend = (
    <Stack direction="row" spacing={2}>
      {(['spent', 'income'] as const).map((k) => (
        <Stack key={k} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: chartColors[k] }} />
          <Typography variant="caption" color="textSecondary">{t(k === 'spent' ? 'dash.spent' : 'dash.income')}</Typography>
        </Stack>
      ))}
    </Stack>
  )

  return (
    <Box>
      {desktop && (
        <PageHeader title={t('dash.title')} bookId={book.id}>
          <Typography variant="body2" color="textSecondary">{thisMonth}</Typography>
        </PageHeader>
      )}
      {empty && <Alert severity="info" sx={{ mt: 2 }}>{t(book.role === 'viewer' ? 'dash.emptyViewer' : 'dash.empty')}</Alert>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'auto auto auto' }, justifyContent: { md: 'start' }, columnGap: { xs: 2, md: 8 },
        rowGap: 2.5, mt: { xs: 0, md: 3.5 }, pb: { xs: 2.5, md: 4 }, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ gridColumn: { xs: '1 / -1', md: 'auto' } }}>
          <Stat big label={t('dash.netWorth')} value={<Money amount={d.net_worth} currency={book.base_currency} kind="balance" />}
            note={d.net_worth_missing_rates ? t('dash.missingRates', { count: d.net_worth_missing_rates }) : undefined} />
        </Box>
        <Stat label={t('dash.spentThisMonth')} value={money(d.spent_this_month)} note={t('dash.vsLastMonth', { amount: money(d.spent_last_month) })} />
        <Stat label={t('dash.incomeThisMonth')} value={money(d.income_this_month)} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 2fr) minmax(0, 1fr)' }, columnGap: 8,
        rowGap: { xs: 3, md: 5 }, mt: { xs: 3, md: 4 }, alignItems: 'start' }}>
        <Section title={t('dash.cashflow')} action={legend}>
          <CashflowChart
            data={cashflow}
            labels={{ spent: t('dash.spent'), income: t('dash.income'), month: t('dash.month') }}
            formatMoney={(v) => money(v)}
            formatAxis={(v) => axis.format(v / 10 ** minor(book.base_currency))}
            formatMonth={(iso) => monthFmt.format(new Date(`${iso}T00:00:00`))}
          />
          {notConverted > 0 && <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>{t('dash.notConverted', { count: notConverted })}</Typography>}
        </Section>

        <Section title={t('dash.topCategories')}>
          {bars.length === 0 && <Typography color="textSecondary">{t('dash.noSpending')}</Typography>}
          {bars.map((b) => {
            const name = b.id ? nameOf.get(b.id) ?? '' : t('dash.uncategorized')
            const color = b.id ? colorOf.get(b.id) : null
            return (
              <Box key={b.id ?? 'none'} onClick={() => b.id && navigate(`/books/${book.id}/transactions?category_id=${b.id}`)}
                sx={{ py: 1.125, cursor: b.id ? 'pointer' : undefined }}>
                <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mb: 1 }}>
                  <Dot color={color} />
                  <Typography noWrap sx={{ flex: 1, minWidth: 0 }}>{name}</Typography>
                  <Typography sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money(b.spent)}</Typography>
                </Stack>
                <Bar label={name} percent={(b.spent / barMax) * 100} color={color || 'text.disabled'} />
              </Box>
            )
          })}
        </Section>

        <Section title={t('dash.recent')} action={seeAll('/transactions')}>
          <List disablePadding>
            {d.recent_transactions.slice(0, 5).map((r) => (
              <ListItemButton key={r.id} onClick={() => openRecent(r.id)} sx={rowSx}>
                <Dot color={colorNamed(r.category)} />
                <ListItemText primary={r.payee || t(`txn.types.${r.type}`)}
                  secondary={[when(r.occurred_on), r.category].filter(Boolean).join(' · ')}
                  slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }} />
                {r.amount !== null && r.currency && (
                  <Money amount={r.amount} currency={r.currency} kind={r.type === 'transfer' ? 'transfer' : 'flow'} sign />
                )}
              </ListItemButton>
            ))}
          </List>
        </Section>

        <Stack spacing={4}>
          <Section title={t('dash.accounts')} action={seeAll('/accounts')}>
            <List disablePadding>
              {shownAccounts.map((a) => (
                <ListItemButton key={a.account_id} onClick={() => navigate(`/books/${book.id}/transactions?account_id=${a.account_id}`)}
                  sx={{ ...rowSx, opacity: a.in_net_worth ? 1 : 0.55 }}>
                  <ListItemText primary={a.name} secondary={t(`accounts.kinds.${a.kind}`)}
                    slotProps={{ primary: { noWrap: true } }} />
                  <Box sx={{ textAlign: 'right' }}>
                    <Money amount={a.balance} currency={a.currency} kind="balance" sx={{ display: 'block' }} />
                    {a.currency !== book.base_currency && (
                      <Typography variant="caption" color="textDisabled" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {a.converted_balance === null ? t('dash.noRate') : `≈ ${money(a.converted_balance)}`}
                      </Typography>
                    )}
                  </Box>
                </ListItemButton>
              ))}
            </List>
            {!pinned.length && d.accounts.length > 0 && (
              <Typography variant="caption" color="textDisabled" component="p" sx={{ mt: 1 }}>{t('dash.pinHint')}</Typography>
            )}
          </Section>

          {d.budgets.length > 0 && (
            <Section title={t('dash.budgets')} action={seeAll('/categories')}>
              <Stack spacing={2.5} sx={{ pt: 0.5 }}>
                {d.budgets.slice(0, 6).map((b) => (
                  <BudgetBar key={b.budget_id} label={`${b.category} · ${t(`budget.periods.${b.period}`)}`} spent={b.spent} budget={b.budget}
                    percent={b.percent_used ?? 0} color={colorOf.get(b.category_id)} format={(v) => money(v)} />
                ))}
              </Stack>
            </Section>
          )}

          {d.people.length > 0 && (
            <Section title={t('dash.people')} action={seeAll('/people')}>
              <List disablePadding>
                {d.people.map((p) => (
                  <ListItemButton key={`${p.contact_id}-${p.currency}`} sx={rowSx} onClick={() => navigate(`/books/${book.id}/people`)}>
                    <ListItemText primary={p.name} slotProps={{ primary: { noWrap: true } }} />
                    <Stack sx={{ textAlign: 'right' }}>
                      {p.owed_to_you > 0 && <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{t('people.owesYou', { amount: money(p.owed_to_you, p.currency) })}</Typography>}
                      {p.you_owe > 0 && <Typography color="error" sx={{ fontVariantNumeric: 'tabular-nums' }}>{t('people.youOwe', { amount: money(p.you_owe, p.currency) })}</Typography>}
                    </Stack>
                  </ListItemButton>
                ))}
              </List>
            </Section>
          )}
        </Stack>
      </Box>
      {credit && (
        <Typography variant="caption" color="textDisabled" component="p" sx={{ mt: 4 }}>
          {t('dash.ratesBy')}{' '}
          <Link href={credit.href} target="_blank" rel="noopener" color="inherit">{credit.label}</Link>
        </Typography>
      )}
    </Box>
  )
}
