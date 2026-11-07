import DeleteIcon from '@mui/icons-material/DeleteOutlined'
import EditIcon from '@mui/icons-material/EditOutlined'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AmountField } from '../components/AmountField'
import { BudgetBar } from '../components/BudgetBar'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { ApiError, budgetPeriods, send, type Book, type Budget, type BudgetPeriod, type Category } from '../lib/api'
import { todayIn } from '../lib/labels'
import { amountText, parseAmount } from '../lib/money'
import { useFormatMoney } from '../lib/hideAmounts'
import { useBudgets, useCategories, useCurrencies, useInvalidateBook } from '../lib/queries'
import { newId } from '../lib/uuid'
import { DateField } from '../components/DateField'
import { DialogFooter } from '../components/DialogFooter'
import { useToast } from '../lib/toast'

type Change = { budget: Budget; amount: string; startsOn: string; endsOn: string; badStarts: boolean; badEnds: boolean; leftOut: string[] }

// A category's budgets, or with no category those for all spending: one per period, in the book's currency.
export function BudgetDialog({ book, category, onClose }: { book: Book; category: Category | null; onClose: () => void }) {
  const formatMoney = useFormatMoney()
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const invalidate = useInvalidateBook()
  const toast = useToast()
  const budgets = useBudgets(book.id)
  const currencies = useCurrencies()
  const minor = currencies.data?.get(book.base_currency)?.minor_unit ?? 0
  const money = (v: number) => formatMoney(v, book.base_currency, minor, lang)
  const categories = useCategories(book.id)
  const expenses = (categories.data ?? []).filter((c) => c.kind === 'expense' && !c.archived_at)
  const nameOf = new Map((categories.data ?? []).map((c) => [c.id, c.name]))
  const mine = (budgets.data ?? []).filter((b) => b.category_id === (category?.id ?? null))
  const [leftOut, setLeftOut] = useState<string[]>([])
  const periodLabel = (b: Budget) => [t(`budget.periods.${b.period}`), ...(b.excluded_category_ids.length
    ? [t('budget.except', { names: b.excluded_category_ids.map((id) => nameOf.get(id)).filter(Boolean).join(', ') })] : [])].join(' · ')
  const leaveOut = (value: string[], onChange: (ids: string[]) => void) => (
    <TextField select label={t('budget.leaveOut')} value={value} onChange={(e) => onChange(e.target.value as unknown as string[])}
      slotProps={{ select: { multiple: true, renderValue: (ids) => (ids as string[]).map((id) => nameOf.get(id)).join(', ') } }}>
      {expenses.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
    </TextField>
  )
  const free = budgetPeriods.filter((p) => !mine.some((b) => b.period === p))
  const [period, setPeriod] = useState<BudgetPeriod>(free.includes('monthly') ? 'monthly' : free[0] ?? 'monthly')
  const [amount, setAmount] = useState('')
  const [startsOn, setStartsOn] = useState(todayIn(book.timezone))
  const [endsOn, setEndsOn] = useState('')
  const [badDates, setBadDates] = useState({ starts: false, ends: false }) // typed but not whole dates yet
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [id] = useState(() => newId())
  const [change, setChange] = useState<Change | null>(null)
  const canEdit = book.role !== 'viewer'
  const parsed = parseAmount(amount, minor, lang)
  const ready = !!parsed && parsed > 0 && !badDates.starts && !badDates.ends
  const changed = change ? parseAmount(change.amount, minor, lang) : null
  const changeReady = !!change && !!changed && changed > 0 && !!change.startsOn && !change.badStarts && !change.badEnds
    && (!change.endsOn || change.endsOn >= change.startsOn)
  const edit = (c: Partial<Change>) => setChange((now) => now && { ...now, ...c })
  const adding = canEdit && !change && free.length > 0

  // The error, or null when it worked.
  async function run(fn: () => Promise<unknown>): Promise<unknown> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return null
    } catch (err) {
      setError(err)
      return err
    } finally {
      setBusy(false)
      await invalidate(book.id)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    const err = await run(() => send('POST', `/v1/books/${book.id}/budgets`, {
      id, category_id: category?.id ?? null, ...(category ? {} : { excluded_category_ids: leftOut }), period, amount: parsed,
      starts_on: startsOn || null, ends_on: endsOn || null,
    }))
    if (!err) {
      toast(t('toast.budgetAdded'))
      onClose()
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!change || !changeReady) return
    const { budget: b, startsOn: starts, endsOn: ends } = change
    const err = await run(() => send('PATCH', `/v1/books/${book.id}/budgets/${b.id}`, {
      version: b.version, amount: changed, starts_on: starts, ...(ends ? { ends_on: ends } : { ongoing: true }),
      ...(category ? {} : { excluded_category_ids: change.leftOut }),
    }))
    if (!err) toast(t('toast.budgetSaved'))
    // A conflict shows the budget as it is now, to change again from there.
    if (!err || (err instanceof ApiError && err.status === 409)) setChange(null)
  }

  const remove = (b: Budget) => run(() => send('DELETE', `/v1/books/${book.id}/budgets/${b.id}?version=${b.version}`))
  const startChange = (b: Budget) => {
    setError(null)
    setChange({ budget: b, amount: amountText(b.amount, minor, lang), startsOn: b.starts_on, endsOn: b.ends_on ?? '', badStarts: false, badEnds: false,
      leftOut: b.excluded_category_ids })
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={change ? save : add}>
        <DialogTitle>{t('budget.title')} · {category?.name ?? t('budget.allSpending')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="textSecondary">{t(category ? 'budget.subcategoriesCount' : 'budget.allCounts')}</Typography>
            {mine.length > 0 && (
              <Stack spacing={2}>
                <Typography variant="subtitle2">{t('budget.existing')}</Typography>
                {mine.map((b) => change?.budget.id === b.id ? (
                  <Stack key={b.id} spacing={2}>
                    <Typography>{t(`budget.periods.${b.period}`)}</Typography>
                    {!category && leaveOut(change.leftOut, (leftOut) => edit({ leftOut }))}
                    <AmountField label={`${t('budget.amount')} (${book.base_currency})`} required autoFocus value={change.amount}
                      onChange={(amount) => edit({ amount })} minorUnit={minor} />
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <DateField label={t('budget.startsOn')} required value={change.startsOn} onChange={(startsOn) => edit({ startsOn })}
                        onInvalid={(badStarts) => edit({ badStarts })} />
                      <DateField label={t('budget.endsOn')} value={change.endsOn} onChange={(endsOn) => edit({ endsOn })}
                        onInvalid={(badEnds) => edit({ badEnds })} />
                    </Stack>
                  </Stack>
                ) : (
                  <Stack key={b.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Stack sx={{ flex: 1, minWidth: 0 }}>
                      {b.progress ? (
                        <BudgetBar label={periodLabel(b)} spent={b.progress.spent} budget={b.amount} percent={b.progress.percent_used} color={category?.color} format={money} />
                      ) : (
                        <Typography variant="body2">{periodLabel(b)} · {money(b.amount)} · {t('budget.notActive')}</Typography>
                      )}
                    </Stack>
                    {canEdit && (
                      <>
                        <IconButton aria-label={t('budget.edit')} onClick={() => startChange(b)} disabled={busy || !!change}>
                          <EditIcon />
                        </IconButton>
                        <IconButton aria-label={t('budget.delete')} onClick={() => remove(b)} disabled={busy || !!change}>
                          <DeleteIcon />
                        </IconButton>
                      </>
                    )}
                  </Stack>
                ))}
                <Divider />
              </Stack>
            )}
            {adding && (
              <Stack spacing={2}>
                <Typography variant="subtitle2">{t('budget.add')}</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField select label={t('budget.period')} value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)} sx={{ minWidth: 160 }}>
                    {free.map((p) => <MenuItem key={p} value={p}>{t(`budget.periods.${p}`)}</MenuItem>)}
                  </TextField>
                  <AmountField label={`${t('budget.amount')} (${book.base_currency})`} required value={amount} onChange={setAmount} minorUnit={minor} />
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <DateField label={t('budget.startsOn')} value={startsOn} onChange={setStartsOn}
                    onInvalid={(starts) => setBadDates((b) => ({ ...b, starts }))} />
                  <DateField label={t('budget.endsOn')} value={endsOn} onChange={setEndsOn}
                    onInvalid={(ends) => setBadDates((b) => ({ ...b, ends }))} />
                </Stack>
                {!category && leaveOut(leftOut, setLeftOut)}
              </Stack>
            )}
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogFooter>
          {change ? (
            <>
              <Button onClick={() => setChange(null)}>{t('common.cancel')}</Button>
              <Button type="submit" variant="contained" loading={busy} disabled={!changeReady}>{t('budget.save')}</Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t(adding ? 'common.cancel' : 'common.close')}</Button>
              {adding && <Button type="submit" variant="contained" loading={busy} disabled={!ready}>{t('budget.save')}</Button>}
            </>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  )
}
