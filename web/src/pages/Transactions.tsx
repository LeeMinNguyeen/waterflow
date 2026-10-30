import SearchIcon from '@mui/icons-material/Search'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemButton from '@mui/material/ListItemButton'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { DateField } from '../components/DateField'
import { useErrorText } from '../components/errors'
import { FilterChip } from '../components/FilterChip'
import { Money } from '../components/Money'
import { PageHeader } from '../components/Page'
import { useOpenTxn } from '../components/txnContext'
import { currentLanguage } from '../i18n'
import { txnTypes, type Account, type Book, type Transaction } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { shiftDay, todayIn } from '../lib/labels'
import { useAccounts, useCategories, useTransactions, type TxnFilters } from '../lib/queries'

const FILTERS = ['account_id', 'category_id', 'type', 'from', 'to', 'q'] as const
type Filter = (typeof FILTERS)[number]
// What a day's total adds up: money that came in or went out, not money moved between your own accounts.
const COUNTED = new Set(['expense', 'income', 'refund'])

// Filters are kept in the URL, so an account can link to its own list.
export function Transactions({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const openTxn = useOpenTxn()
  const [params, setParams] = useSearchParams()
  const filters: TxnFilters = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? undefined]).filter(([, v]) => v))
  const [search, setSearch] = useState(filters.q ?? '')
  const [menu, setMenu] = useState<{ el: HTMLElement; which: 'account' | 'category' | 'type' | 'dates' } | null>(null)
  // Clear starts the date fields afresh: a half-typed date isn't in the address, so clearing it wouldn't reach them.
  const [cleared, setCleared] = useState(0)
  const txns = useTransactions(book.id, filters)
  const accounts = useAccounts(book.id, true)
  const categories = useCategories(book.id, true)

  // Search as the user types, a moment after they stop.
  useEffect(() => {
    const id = setTimeout(() => setFilter('q', search.trim()), 350)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  function setFilter(key: Filter, value: string) {
    setParams(
      (p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: true },
    )
  }
  const pick = (key: Filter, value: string) => {
    setMenu(null)
    setFilter(key, value)
  }

  const accountById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data])
  const categoryById = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c])), [categories.data])
  const tree = useMemo(() => categoryTree(categories.data ?? []), [categories.data])
  const items = txns.data?.pages.flatMap((p) => p.items) ?? []
  const filtered = Object.keys(filters).length > 0
  const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
  const fullDay = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const dayThisYear = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' })
  const shortDate = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' })
  const date = (iso: string) => new Date(`${iso}T00:00:00`)
  const today = todayIn(book.timezone)

  // The amount shown for a row: the filtered account's side, else the money out
  // of the first account (a transfer shows the amount moved).
  function shown(txn: Transaction) {
    const e =
      txn.entries.find((x) => x.account_id === filters.account_id) ??
      (txn.type === 'transfer' ? txn.entries.find((x) => x.amount < 0) : txn.entries[0]) ??
      txn.entries[0]
    return { amount: e.amount, currency: e.currency ?? '' }
  }
  const accountsOf = (txn: Transaction) => {
    const names = [...txn.entries].sort((a, b) => a.amount - b.amount).map((e) => accountById.get(e.account_id)?.name ?? '')
    return txn.type === 'transfer' ? names.join(' → ') : names[0]
  }
  const title = (txn: Transaction) => txn.payee || t(`txn.types.${txn.type}`)
  const kindOf = (txn: Transaction) => (txn.type === 'transfer' && !filters.account_id ? 'transfer' : 'flow')
  const filteredAccount: Account | undefined = filters.account_id ? accountById.get(filters.account_id) : undefined

  const days: { on: string; txns: Transaction[] }[] = []
  for (const txn of items) {
    if (days.at(-1)?.on === txn.occurred_on) days.at(-1)!.txns.push(txn)
    else days.push({ on: txn.occurred_on, txns: [txn] })
  }
  function total(txns: Transaction[]) {
    const counted = txns.filter((x) => COUNTED.has(x.type)).map(shown)
    if (!counted.length || new Set(counted.map((c) => c.currency)).size > 1) return null
    return { amount: counted.reduce((sum, c) => sum + c.amount, 0), currency: counted[0].currency }
  }
  const dayName = (on: string) =>
    on === today ? t('txn.today') : on === shiftDay(today, -1) ? t('txn.yesterday') : null

  const columns = `48px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1.2fr) 150px${filteredAccount ? ' 140px' : ''}`
  const accountName = filters.account_id ? accountById.get(filters.account_id)?.name : undefined
  const categoryName = filters.category_id ? categoryById.get(filters.category_id)?.name : undefined
  const datesValue =
    filters.from && filters.to ? `${shortDate.format(date(filters.from))} – ${shortDate.format(date(filters.to))}`
      : filters.from ? t('filters.since', { date: shortDate.format(date(filters.from)) })
        : filters.to ? t('filters.until', { date: shortDate.format(date(filters.to)) }) : undefined
  const open = (which: NonNullable<typeof menu>['which']) => (e: MouseEvent<HTMLElement>) => setMenu({ el: e.currentTarget, which })
  const people = (accounts.data ?? []).filter((a) => a.kind === 'person')

  return (
    <Box>
      <PageHeader title={filteredAccount ? `${t('txn.title')} · ${filteredAccount.name}` : t('txn.title')} bookId={book.id} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 1.5, md: 1 }} sx={{ mt: { xs: 2, md: 3 }, alignItems: { md: 'center' } }}>
        <TextField
          size="small"
          placeholder={t('filters.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: { md: 300 }, flexShrink: 0 }}
          slotProps={{ htmlInput: { 'aria-label': t('filters.search') }, input: { startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment> } }}
        />
        <Stack direction="row" spacing={1} sx={{ overflowX: 'auto', pb: { xs: 0.5, md: 0 }, alignItems: 'center' }}>
          <FilterChip label={t('txn.account')} value={accountName} onClick={open('account')}
            onClear={() => setFilter('account_id', '')} clearLabel={t('filters.clearOne', { name: t('txn.account') })} />
          <FilterChip label={t('txn.category')} value={categoryName} onClick={open('category')}
            onClear={() => setFilter('category_id', '')} clearLabel={t('filters.clearOne', { name: t('txn.category') })} />
          <FilterChip label={t('filters.type')} value={filters.type ? t(`txn.types.${filters.type}`) : undefined} onClick={open('type')}
            onClear={() => setFilter('type', '')} clearLabel={t('filters.clearOne', { name: t('filters.type') })} />
          <FilterChip label={t('filters.dates')} value={datesValue} onClick={open('dates')}
            onClear={() => { setCleared((n) => n + 1); setFilter('from', ''); setFilter('to', '') }}
            clearLabel={t('filters.clearOne', { name: t('filters.dates') })} />
          {filtered && (
            <Button size="small" sx={{ flexShrink: 0 }} onClick={() => { setSearch(''); setCleared((n) => n + 1); setParams({}, { replace: true }) }}>
              {t('filters.clear')}
            </Button>
          )}
        </Stack>
      </Stack>

      <Menu anchorEl={menu?.el} open={menu?.which === 'account'} onClose={() => setMenu(null)}>
        <MenuItem selected={!filters.account_id} onClick={() => pick('account_id', '')}>{t('filters.allAccounts')}</MenuItem>
        {(accounts.data ?? []).filter((a) => a.kind !== 'person').map((a) => (
          <MenuItem key={a.id} selected={a.id === filters.account_id} onClick={() => pick('account_id', a.id)}>{a.name}</MenuItem>
        ))}
        {people.length > 0 && <ListSubheader>{t('txn.people')}</ListSubheader>}
        {people.map((a) => (
          <MenuItem key={a.id} selected={a.id === filters.account_id} onClick={() => pick('account_id', a.id)}>{a.name}</MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={menu?.el} open={menu?.which === 'category'} onClose={() => setMenu(null)} slotProps={{ paper: { sx: { maxHeight: 420 } } }}>
        <MenuItem selected={!filters.category_id} onClick={() => pick('category_id', '')}>{t('filters.allCategories')}</MenuItem>
        {tree.map(({ category: c, depth }) => (
          <MenuItem key={c.id} selected={c.id === filters.category_id} onClick={() => pick('category_id', c.id)} sx={{ pl: 2 + depth * 2, gap: 1.25 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: c.color || 'text.disabled', flexShrink: 0 }} />
            {c.name}
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={menu?.el} open={menu?.which === 'type'} onClose={() => setMenu(null)}>
        <MenuItem selected={!filters.type} onClick={() => pick('type', '')}>{t('filters.allTypes')}</MenuItem>
        {txnTypes.map((ty) => (
          <MenuItem key={ty} selected={ty === filters.type} onClick={() => pick('type', ty)}>{t(`txn.types.${ty}`)}</MenuItem>
        ))}
      </Menu>
      <Popover anchorEl={menu?.el} open={menu?.which === 'dates'} onClose={() => setMenu(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }} slotProps={{ paper: { sx: { p: 2, mt: 1, width: 300 } } }}>
        <Stack spacing={2}>
          <DateField key={`from-${cleared}`} label={t('filters.from')} value={filters.from ?? ''} onChange={(v) => setFilter('from', v)} />
          <DateField key={`to-${cleared}`} label={t('filters.to')} value={filters.to ?? ''} onChange={(v) => setFilter('to', v)} />
          {(filters.from || filters.to) && (
            <Button sx={{ alignSelf: 'start' }} onClick={() => { setCleared((n) => n + 1); setFilter('from', ''); setFilter('to', ''); setMenu(null) }}>
              {t('filters.clearDates')}
            </Button>
          )}
        </Stack>
      </Popover>

      {txns.isError && !txns.data && <Alert severity="error" sx={{ mt: 3 }}>{errorText(txns.error)}</Alert>}
      {txns.isSuccess && items.length === 0 && (
        <Typography color="textSecondary" sx={{ mt: 3 }}>{t(filtered ? 'txn.noMatch' : 'txn.empty')}</Typography>
      )}

      {items.length > 0 && desktop && (
        <Box sx={{ display: 'grid', gridTemplateColumns: columns, columnGap: 2, px: 1.5, pt: 2.5, typography: 'caption', color: 'text.disabled' }} aria-hidden>
          <span>{t('txn.time')}</span>
          <span>{t('txn.payee')}</span>
          <span>{t('txn.category')}</span>
          <span>{t('txn.account')}</span>
          <Box component="span" sx={{ textAlign: 'right' }}>{t('txn.amount')}</Box>
          {filteredAccount && <Box component="span" sx={{ textAlign: 'right' }}>{t('txn.balance')}</Box>}
        </Box>
      )}

      {days.map((day) => (
        <Day key={day.on} label={dayName(day.on)} total={total(day.txns)} desktop={desktop}
          date={(day.on.slice(0, 4) === today.slice(0, 4) ? dayThisYear : fullDay).format(date(day.on))}>
          {day.txns.map((txn) => {
            const money = shown(txn)
            const cat = txn.category_id ? categoryById.get(txn.category_id) : undefined
            const amount = <Money amount={money.amount} currency={money.currency} kind={kindOf(txn)} sign />
            if (!desktop) {
              return (
                <ListItemButton key={txn.id} onClick={() => openTxn(txn)}
                  sx={{ px: 0, py: 0.75, minHeight: 56, gap: 1.5, '&:not(:first-of-type)': { borderTop: 1, borderColor: 'divider' } }}>
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: cat?.color || 'text.disabled' }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography noWrap>{title(txn)}</Typography>
                    <Typography variant="body2" color="textSecondary" noWrap>
                      {[txn.occurred_time.slice(0, 5), cat?.name, accountsOf(txn)].filter(Boolean).join(' · ')}
                    </Typography>
                  </Box>
                  {amount}
                </ListItemButton>
              )
            }
            return (
              <ListItemButton key={txn.id} onClick={() => openTxn(txn)}
                sx={{ display: 'grid', gridTemplateColumns: columns, columnGap: 2, alignItems: 'center', minHeight: 52, px: 1.5, py: 0.75, borderRadius: 1 }}>
                <Typography variant="body2" color="textDisabled" sx={{ fontVariantNumeric: 'tabular-nums' }}>{txn.occurred_time.slice(0, 5)}</Typography>
                <Box sx={{ minWidth: 0 }}>
                  <Typography noWrap>{title(txn)}</Typography>
                  {txn.note && <Typography variant="body2" color="textSecondary" noWrap>{txn.note}</Typography>}
                </Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, color: 'text.secondary' }}>
                  {cat ? (
                    <>
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: cat.color || 'text.disabled' }} />
                      <Typography noWrap>{cat.name}</Typography>
                    </>
                  ) : <Typography color="textDisabled">—</Typography>}
                </Stack>
                <Typography color="textSecondary" noWrap>{accountsOf(txn)}</Typography>
                <Box sx={{ textAlign: 'right' }}>{amount}</Box>
                {filteredAccount && (
                  <Box sx={{ textAlign: 'right' }}>
                    {txn.running_balance !== null && <Money amount={txn.running_balance} currency={filteredAccount.currency} kind="balance" sx={{ color: 'text.secondary' }} />}
                  </Box>
                )}
              </ListItemButton>
            )
          })}
        </Day>
      ))}

      {txns.hasNextPage && (
        <Box sx={{ textAlign: 'center', mt: 3 }}>
          <Button variant="outlined" onClick={() => txns.fetchNextPage()} loading={txns.isFetchingNextPage}>
            {t('txn.loadMore')}
          </Button>
        </Box>
      )}
    </Box>
  )
}

function Day({ label, date, total, desktop, children }: {
  label: string | null; date: string; total: { amount: number; currency: string } | null; desktop: boolean; children: ReactNode
}) {
  const id = useId()
  return (
    <Box component="section" aria-labelledby={id}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', pt: desktop ? 3 : 2.5, pb: 1, px: desktop ? 1.5 : 0,
        mb: desktop ? 0.5 : 0, borderBottom: 1, borderColor: 'divider' }}>
        <Typography id={id} variant="body2" sx={{ fontWeight: 600, color: 'text.secondary' }}>
          {label ?? date}
          {label && desktop && <Box component="span" sx={{ fontWeight: 400, color: 'text.disabled' }}> · {date}</Box>}
        </Typography>
        {total && <Money variant="body2" amount={total.amount} currency={total.currency} sign />}
      </Stack>
      {children}
    </Box>
  )
}
