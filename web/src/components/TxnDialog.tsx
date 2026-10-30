import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import DeleteIcon from '@mui/icons-material/DeleteOutlined'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import HistoryIcon from '@mui/icons-material/History'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import ListItemButton from '@mui/material/ListItemButton'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { api, ApiError, categoryKindFor, send, type Account, type Book, type Entry, type Suggestion, type Transaction, type TxnType } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { shiftDay, timeIn, todayIn } from '../lib/labels'
import { amountText, formatMoney, parseAmount } from '../lib/money'
import { personName } from '../lib/people'
import { fromPlan, noPlan, validMonths, type PlanForm } from '../lib/installments'
import { useAccounts, useBooks, useCategories, useCurrencies, useInstallments, useInvalidateBook } from '../lib/queries'
import { AmountField } from './AmountField'
import { CategoryPicker } from './CategoryPicker'
import { DateField } from './DateField'
import { TimeField } from './TimeField'
import { useErrorText } from './errors'
import { HistoryDialog } from './HistoryDialog'
import { InstallmentFields } from './InstallmentFields'
import { Money } from './Money'
import { CategoryPills, PickRow, Pill, Sheet } from './PhoneForm'
import { newId } from '../lib/uuid'
import { DialogFooter } from './DialogFooter'
import { useToast } from '../lib/toast'

const mainTypes: TxnType[] = ['expense', 'income', 'transfer']
const otherTypes: TxnType[] = ['refund', 'adjustment']

type Form = {
  type: TxnType
  date: string
  time: string
  account: string
  toAccount: string
  amount: string
  amountReceived: string
  category: string
  payee: string
  note: string
}

export type TxnDefaults = { account?: string }

type Props = { book: Book; txn: Transaction | null; defaults?: TxnDefaults; onClose: () => void }
type FormProps = Props & {
  minorOf: (currency: string) => number
  carry?: Partial<Form>
  onSwitchBook?: (book: Book, carry: Partial<Form>) => void
}

// The form needs each currency's decimals to show saved amounts, so it waits for them. A new transaction can go
// into another book: the form starts again there, keeping what doesn't belong to the book.
export function TxnDialog(props: Props) {
  const currencies = useCurrencies()
  const [into, setInto] = useState<{ book: Book; carry: Partial<Form> } | null>(null)
  if (!currencies.data) return null
  const map = currencies.data
  const book = into?.book ?? props.book
  return (
    <TxnForm key={book.id} {...props} book={book} carry={into?.carry} minorOf={(code) => map.get(code)?.minor_unit ?? 0}
      onSwitchBook={props.txn ? undefined : (b, carry) => setInto({ book: b, carry })} />
  )
}

// Amounts are typed as positive numbers; the type decides the sign (an expense
// is money out). Adjustments take a sign.
function TxnForm({ book, txn: initial, defaults, onClose, minorOf, carry, onSwitchBook }: FormProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const accounts = useAccounts(book.id, true)
  const categories = useCategories(book.id, true)
  const invalidate = useInvalidateBook()
  const id = useRef(initial?.id ?? newId()) // made once, reused on retry
  const [txn, setTxn] = useState(initial)
  const [form, setForm] = useState<Form>(() => ({ ...toForm(initial, book, minorOf, defaults), ...carry }))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [moreMenu, setMoreMenu] = useState<HTMLElement | null>(null)
  const [sheet, setSheet] = useState<'book' | 'account' | 'toAccount' | 'date' | 'time' | 'payee' | null>(null)
  const [search, setSearch] = useState('')
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const books = useBooks()
  const [planEdit, setPlanEdit] = useState<PlanForm | null>(null) // null: as saved
  const planId = useRef(newId())
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  // What the user set themselves, which a suggestion never overwrites; an account given by the caller counts.
  const touched = useRef(new Set<'account' | 'category' | 'payee'>(defaults?.account ? ['account'] : []))
  const choose = (field: 'account' | 'category' | 'payee', value: string) => {
    touched.current.add(field)
    set({ [field]: value })
  }

  const accountList = accounts.data ?? []
  const byId = new Map(accountList.map((a) => [a.id, a]))
  const usable = (a: Account) => !a.archived_at || txn?.entries.some((e) => e.account_id === a.id)
  const open = accountList.filter(usable)
  // With a single open account there's nothing to pick: it's the one.
  const account = form.account || (open.length === 1 ? open[0].id : '')
  const minor = (accountId: string) => minorOf(byId.get(accountId)?.currency ?? '')
  const from = byId.get(account)
  const to = byId.get(form.toAccount)
  const transfer = form.type === 'transfer'
  const crossCurrency = transfer && !!from && !!to && from.currency !== to.currency
  const kind = categoryKindFor[form.type]
  const options = useMemo(
    () => (kind ? categoryTree(categories.data ?? [], kind).filter((r) => !r.category.archived_at || r.category.id === form.category) : []),
    [categories.data, kind, form.category],
  )

  function money(): { account_id: string; amount: number }[] | null {
    const a = parseAmount(form.amount, minor(account), lang)
    if (a === null || a === 0 || !account) return null
    if (form.type === 'adjustment') return [{ account_id: account, amount: a }]
    const abs = Math.abs(a)
    if (form.type === 'expense') return [{ account_id: account, amount: -abs }]
    if (!transfer) return [{ account_id: account, amount: abs }]
    if (!form.toAccount || form.toAccount === account) return null
    const received = crossCurrency ? parseAmount(form.amountReceived, minor(form.toAccount), lang) : abs
    if (received === null || received === 0) return null
    return [{ account_id: account, amount: -abs }, { account_id: form.toAccount, amount: Math.abs(received) }]
  }
  const entries = money()

  // A new expense or income fills in from the user's own history once the amount is typed.
  const suggestible = !txn && (form.type === 'expense' || form.type === 'income')
  const typed = suggestible ? parseAmount(form.amount, minorOf(from?.currency ?? book.base_currency), lang) : null
  useEffect(() => {
    if (!typed || typed <= 0) return
    let current = true
    const timer = setTimeout(async () => {
      try {
        const s = await api<Suggestion | null>(`/v1/books/${book.id}/transactions/suggest?type=${form.type}&amount=${typed}`)
        if (!current || !s) return
        const patch: Partial<Form> = {}
        if (!touched.current.has('account') && accountList.some((a) => a.id === s.account_id && !a.archived_at)) patch.account = s.account_id
        if (!touched.current.has('category') && s.category_id && options.some((o) => o.category.id === s.category_id)) patch.category = s.category_id
        if (!touched.current.has('payee') && s.payee) patch.payee = s.payee
        setForm((f) => ({ ...f, ...patch }))
      } catch {
        // A suggestion is a convenience: without one the form stays as it is.
      }
    }, 400)
    return () => {
      current = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asks again only when the amount or the type changes
  }, [typed, form.type])

  const card = form.type === 'expense' && from?.kind === 'credit_card' ? from : null
  const savedOnCard = !!txn && txn.entries.some((e) => byId.get(e.account_id)?.kind === 'credit_card')
  const installments = useInstallments(book.id, !!card || savedOnCard)
  const saved = txn ? installments.data?.find((p) => p.transaction_id === txn.id) : undefined
  const plan = planEdit ?? (saved ? fromPlan(saved, amountText(saved.fee, minor(saved.account_id), lang)) : noPlan)
  const setPlan = (patch: Partial<PlanForm>) => setPlanEdit({ ...plan, ...patch })
  const planned = !!card?.statement_day && plan.on
  const fee = parseAmount(plan.fee || '0', minor(account), lang)
  const planReady = !planned || (validMonths(plan.months) && fee !== null && fee >= 0)
  const losesPlan = !!saved && !(card && card.id === saved.account_id)

  async function savePlan() {
    if (planned) {
      const fields = {
        months: Number(plan.months), converted_on: plan.convertedOn || (txn ? todayIn(book.timezone) : form.date), fee: fee ?? 0,
        fee_split: plan.feeSplit, counts_toward_limit: plan.countsTowardLimit, ...(plan.firstStatement ? { first_statement: plan.firstStatement } : {}),
      }
      if (!saved) {
        await send('POST', `/v1/books/${book.id}/installments`, { id: planId.current, transaction_id: id.current, ...fields })
        return
      }
      const before: Record<string, unknown> = { months: saved.months, converted_on: saved.converted_on, fee: saved.fee,
        fee_split: saved.fee_split, counts_toward_limit: saved.counts_toward_limit, first_statement: saved.first_statement }
      const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => before[k] !== v))
      if (Object.keys(changed).length) await send('PATCH', `/v1/books/${book.id}/installments/${saved.id}`, { version: saved.version, ...changed })
    } else if (saved && !losesPlan) {
      await send('DELETE', `/v1/books/${book.id}/installments/${saved.id}?version=${saved.version}`)
    }
  }

  async function reload(message: unknown) {
    // Another device saved first: show the newer version and say so.
    try {
      const latest = await api<Transaction>(`/v1/books/${book.id}/transactions/${id.current}`)
      setTxn(latest)
      setForm(toForm(latest, book, minorOf))
    } catch {
      onClose()
    }
    setError(message)
    await invalidate(book.id)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!entries || !form.time) return
    setBusy(true)
    setError(null)
    const body = {
      type: form.type,
      occurred_on: form.date,
      occurred_time: form.time,
      entries,
      category_id: form.category || null,
      payee: form.payee.trim() || null,
      note: form.note.trim() || null,
    }
    try {
      if (txn) await send('PUT', `/v1/books/${book.id}/transactions/${txn.id}`, { ...body, version: txn.version })
      else await send('POST', `/v1/books/${book.id}/transactions`, { ...body, id: id.current })
      await savePlan()
      await invalidate(book.id)
      toast(t('toast.txnSaved'))
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && txn) await reload(err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!txn) return
    setBusy(true)
    try {
      await send('DELETE', `/v1/books/${book.id}/transactions/${txn.id}?version=${txn.version}`)
      await invalidate(book.id)
      toast(t('toast.txnDeleted'))
      onClose()
    } catch (err) {
      setConfirmDelete(false)
      if (err instanceof ApiError && err.status === 409) await reload(err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  const noAccounts = accounts.isSuccess && open.length === 0
  const readOnly = book.role === 'viewer'
  const openingBalance = form.type === 'opening_balance'
  const accountLabel = (a: Account) => `${a.name} · ${formatMoney(a.balance, a.currency, minor(a.id), lang)}`
  const people = open.filter((a) => a.kind === 'person')
  const accountOptions = [
    ...open.filter((a) => a.kind !== 'person').map((a) => <MenuItem key={a.id} value={a.id}>{accountLabel(a)}</MenuItem>),
    ...(people.length ? [<ListSubheader key="people">{t('txn.people')}</ListSubheader>] : []),
    ...people.map((a) => <MenuItem key={a.id} value={a.id}>{accountLabel(a)}</MenuItem>),
  ]

  const two = { display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } } as const
  const typeSx = { whiteSpace: 'nowrap', minWidth: 0, px: { xs: 0.5, sm: 1.5 }, fontSize: { xs: 13, sm: 14 } } as const
  const ready = !!entries && !!form.date && !!form.time && planReady
  const other = otherTypes.includes(form.type) ? form.type : null
  const extras = (
    <>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>{t('txn.deleteConfirm')}</DialogTitle>
        <DialogFooter>
          <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" loading={busy} onClick={remove}>
            {t('txn.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
      {showHistory && txn && <HistoryDialog book={book} txnId={txn.id} onClose={() => setShowHistory(false)} />}
    </>
  )

  if (fullScreen) {
    const inflow = form.type === 'income' || form.type === 'refund'
    const tone = form.type === 'expense' ? 'error.main' : inflow ? 'success.main' : 'text.primary'
    const sign = form.type === 'expense' ? '−' : inflow ? '+' : ''
    const today = todayIn(book.timezone)
    const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
    const day = form.date ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(`${form.date}T00:00:00`)) : ''
    const relative = form.date === today ? t('txn.today') : form.date === shiftDay(today, -1) ? t('txn.yesterday') : null
    const balanceOf = (a: Account) => `${a.name} (${formatMoney(a.balance, a.currency, minor(a.id), lang)})`
    const picking = sheet === 'account' || sheet === 'toAccount'
    const matches = (a: Account) => a.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    const pickAccount = (id: string) => {
      if (sheet === 'toAccount') set({ toAccount: id })
      else choose('account', id)
      setSheet(null)
      setSearch('')
    }
    const accountItem = (a: Account) => (
      <ListItemButton key={a.id} selected={a.id === (sheet === 'toAccount' ? form.toAccount : account)} onClick={() => pickAccount(a.id)}
        sx={{ px: 0, minHeight: 56, gap: 2, borderTop: 1, borderColor: 'divider' }}>
        <Typography sx={{ flex: 1, minWidth: 0 }} noWrap>{a.name}</Typography>
        <Money amount={a.balance} currency={a.currency} kind="balance" variant="body2" />
      </ListItemButton>
    )
    const editable = (books.data ?? []).filter((b) => b.role !== 'viewer' && !b.archived_at)
    return (
      <Dialog open onClose={onClose} fullScreen slotProps={{ paper: { component: 'form', onSubmit: submit } }}>
        <Stack direction="row" sx={{ alignItems: 'center', minHeight: 56, px: 0.5, gap: 0.5 }}>
          <IconButton aria-label={t('common.close')} onClick={onClose} sx={{ color: 'text.primary' }}><ArrowBackIcon /></IconButton>
          {onSwitchBook ? (
            <Button onClick={() => setSheet('book')} endIcon={<ExpandMoreIcon />} aria-label={t('txn.bookOf', { name: book.name })}
              sx={{ color: 'text.primary', fontSize: 18, fontWeight: 600, minWidth: 0, px: 1 }}>
              <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{book.name}</Box>
            </Button>
          ) : (
            <Typography component="h2" noWrap sx={{ fontSize: 18, fontWeight: 600, px: 1 }}>{t('txn.edit')}</Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {txn && (
            <IconButton aria-label={t('txn.moreActions')} onClick={(e) => setActions(e.currentTarget)} sx={{ color: 'text.primary' }}>
              <MoreVertIcon />
            </IconButton>
          )}
        </Stack>
        <DialogContent sx={{ px: 2, pt: 1 }}>
          <Stack spacing={2.5}>
            {openingBalance || form.type === 'adjustment' ? (
              <Typography color="text.secondary">{t(`txn.types.${form.type}`)}</Typography>
            ) : (
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.25 }}>
                {mainTypes.map((ty) => {
                  const on = ty === form.type || (ty === 'expense' && form.type === 'refund')
                  return (
                    <Pill key={ty} look="filled" selected={on} aria-pressed={on} disabled={readOnly}
                      onClick={() => !on && set({ type: ty, category: '' })}>
                      {t(`txn.types.${ty}`)}
                    </Pill>
                  )
                })}
              </Box>
            )}
            <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.5, borderBottom: 1, borderColor: 'divider', pb: 0.5 }}>
              {sign && <Typography aria-hidden sx={{ fontSize: 40, lineHeight: '48px', fontWeight: 500, color: tone }}>{sign}</Typography>}
              <AmountField
                ariaLabel={t('txn.amount')}
                autoFocus={!txn}
                value={form.amount}
                onChange={(v) => set({ amount: v })}
                minorUnit={minor(account)}
                disabled={readOnly}
                helperText={form.type === 'adjustment' ? t('txn.adjustmentHint') : undefined}
                sx={{ '& .MuiOutlinedInput-notchedOutline': { border: 0 }, '& .MuiOutlinedInput-root.Mui-focused': { boxShadow: 'none' },
                  '& .MuiOutlinedInput-input': { p: 0, fontSize: 40, lineHeight: '48px', height: 48, fontWeight: 500, color: tone,
                    fontVariantNumeric: 'tabular-nums' } }}
              />
              {from && <Typography color="text.disabled" sx={{ fontWeight: 500 }}>{from.currency}</Typography>}
            </Stack>
            {kind && (
              <CategoryPills rows={options} value={form.category} onChange={(id) => choose('category', id)} disabled={readOnly}
                color={form.type === 'expense' ? 'error.main' : inflow ? 'success.main' : 'primary.main'} noneLabel={t('txn.noCategory')} />
            )}
            {noAccounts && <Alert severity="info">{t('txn.needAccount')}</Alert>}
            {transfer && open.length < 2 && !noAccounts && <Alert severity="info">{t('txn.needTwoAccounts')}</Alert>}
            <Box>
              <PickRow label={t(transfer ? 'txn.fromAccount' : 'txn.account')} value={from && balanceOf(from)} placeholder={t('txn.chooseAccount')}
                disabled={openingBalance || readOnly} onClick={() => setSheet('account')} />
              {transfer && (
                <PickRow label={t('txn.toAccount')} value={to && balanceOf(to)} placeholder={t('txn.chooseAccount')} disabled={readOnly}
                  onClick={() => setSheet('toAccount')} />
              )}
              {transfer && form.toAccount && form.toAccount === account && (
                <Typography variant="caption" color="error" component="p" sx={{ mt: 0.5 }}>{t('txn.sameAccount')}</Typography>
              )}
            </Box>
            {crossCurrency && (
              <AmountField label={`${t('txn.amountReceived')} (${to?.currency})`} required value={form.amountReceived}
                onChange={(v) => set({ amountReceived: v })} minorUnit={minor(form.toAccount)} unit={to?.currency} disabled={readOnly} />
            )}
            <TextField label={t('txn.note')} value={form.note} onChange={(e) => set({ note: e.target.value })} multiline minRows={1} maxRows={4}
              placeholder={t('txn.noteHint')} disabled={readOnly} />
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Pill disabled={readOnly} onClick={() => setSheet('date')} aria-label={`${t('txn.date')}: ${day}`}>
                {day}{relative && ` · ${relative}`}
              </Pill>
              <Pill disabled={readOnly} onClick={() => setSheet('time')} aria-label={`${t('txn.time')}: ${form.time}`}>{form.time}</Pill>
              <Pill disabled={readOnly} onClick={() => setSheet('payee')} aria-label={form.payee ? `${t('txn.payee')}: ${form.payee}` : t('txn.payee')}
                sx={{ color: form.payee ? 'text.primary' : 'text.disabled', maxWidth: '100%' }}>
                {form.payee || t('txn.payee')}
              </Pill>
            </Stack>
            {(form.type === 'expense' || form.type === 'refund') && (
              <FormControlLabel label={t('txn.types.refund')} disabled={readOnly}
                control={<Checkbox checked={form.type === 'refund'} onChange={(e) => set({ type: e.target.checked ? 'refund' : 'expense' })} />} />
            )}
            {card && !readOnly && (!txn || installments.isFetched) && (
              <InstallmentFields card={card} plan={plan} onChange={setPlan} purchaseDate={form.date}
                amount={entries ? Math.abs(entries[0].amount) : null} minorUnit={minor(card.id)} />
            )}
            {losesPlan && !readOnly && <Alert severity="warning">{t('plan.removedOnSave')}</Alert>}
            {txn?.created_by && (
              <Typography variant="body2" color="text.secondary">
                {t('txn.createdBy', { name: personName(txn.created_by, t), editor: personName(txn.modified_by, t) })}
              </Typography>
            )}
            {error ? <Alert severity={error instanceof ApiError && error.status === 409 ? 'warning' : 'error'}>{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        {!readOnly && (
          <Box sx={{ px: 2, pt: 1.5, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <Button type="submit" variant="contained" fullWidth loading={busy} disabled={!ready}
              sx={{ minHeight: 52, borderRadius: 999, fontSize: 16, fontWeight: 600 }}>
              {t('txn.save')}
            </Button>
          </Box>
        )}
        <Menu anchorEl={actions} open={!!actions} onClose={() => setActions(null)}>
          <MenuItem onClick={() => { setActions(null); setShowHistory(true) }}>{t('txn.history')}</MenuItem>
          {!readOnly && <MenuItem onClick={() => { setActions(null); setConfirmDelete(true) }}>{t('txn.delete')}</MenuItem>}
        </Menu>
        <Sheet open={sheet === 'book'} title={t('book.switch')} onClose={() => setSheet(null)}>
          {editable.map((b) => (
            <ListItemButton key={b.id} selected={b.id === book.id} sx={{ px: 0, minHeight: 52, borderTop: 1, borderColor: 'divider' }}
              onClick={() => {
                setSheet(null)
                if (b.id !== book.id) onSwitchBook?.(b, { type: form.type, amount: form.amount, date: form.date, time: form.time, payee: form.payee,
                  note: form.note, account: '', toAccount: '', amountReceived: '', category: '' })
              }}>
              {b.name}
            </ListItemButton>
          ))}
        </Sheet>
        <Sheet open={picking} title={t(sheet === 'toAccount' ? 'txn.toAccount' : transfer ? 'txn.fromAccount' : 'txn.account')}
          onClose={() => { setSheet(null); setSearch('') }}>
          <TextField size="small" placeholder={t('txn.searchAccounts')} value={search} onChange={(e) => setSearch(e.target.value)}
            slotProps={{ htmlInput: { 'aria-label': t('txn.searchAccounts') } }} sx={{ mb: 1 }} />
          {open.filter((a) => a.kind !== 'person' && matches(a)).map(accountItem)}
          {people.some(matches) && <ListSubheader disableSticky sx={{ px: 0, bgcolor: 'transparent' }}>{t('txn.people')}</ListSubheader>}
          {people.filter(matches).map(accountItem)}
        </Sheet>
        <Sheet open={sheet === 'date'} title={t('txn.date')} onClose={() => setSheet(null)} done={() => setSheet(null)}>
          <DateField label={t('txn.date')} required value={form.date} onChange={(date) => set({ date })} />
        </Sheet>
        <Sheet open={sheet === 'time'} title={t('txn.time')} onClose={() => setSheet(null)} done={() => setSheet(null)}>
          <TimeField label={t('txn.time')} required value={form.time} onChange={(time) => set({ time })} />
        </Sheet>
        <Sheet open={sheet === 'payee'} title={t('txn.payee')} onClose={() => setSheet(null)} done={() => setSheet(null)}>
          <TextField autoFocus value={form.payee} onChange={(e) => choose('payee', e.target.value)}
            slotProps={{ htmlInput: { 'aria-label': t('txn.payee') } }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSheet(null) } }} />
        </Sheet>
        {extras}
      </Dialog>
    )
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" slotProps={{ paper: { component: 'form', onSubmit: submit } }}>
      <DialogTitle>{t(txn ? 'txn.edit' : 'txn.add')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {openingBalance ? (
            <Typography color="text.secondary">{t('txn.types.opening_balance')}</Typography>
          ) : (
            <ToggleButtonGroup
              exclusive
              fullWidth
              value={other ? 'more' : form.type}
              onChange={(_, v: TxnType | null) => v && set({ type: v, category: '' })}
            >
              {mainTypes.map((ty) => (
                <ToggleButton key={ty} value={ty} sx={typeSx}>
                  {t(`txn.types.${ty}`)}
                </ToggleButton>
              ))}
              <ToggleButton value="more" aria-haspopup="true" sx={{ ...typeSx, gap: 0.5 }}
                onClick={(e) => { e.preventDefault(); setMoreMenu(e.currentTarget) }}>
                {other ? t(`txn.types.${other}`) : t('txn.moreTypes')}
                <ExpandMoreIcon sx={{ fontSize: 16 }} />
              </ToggleButton>
            </ToggleButtonGroup>
          )}
          <Menu anchorEl={moreMenu} open={!!moreMenu} onClose={() => setMoreMenu(null)}>
            {otherTypes.map((ty) => (
              <MenuItem key={ty} selected={ty === form.type} onClick={() => { setMoreMenu(null); set({ type: ty, category: '' }) }}>
                {t(`txn.types.${ty}`)}
              </MenuItem>
            ))}
          </Menu>
          {noAccounts && <Alert severity="info">{t('txn.needAccount')}</Alert>}
          {transfer && open.length < 2 && !noAccounts && <Alert severity="info">{t('txn.needTwoAccounts')}</Alert>}
          <AmountField
            big
            label={t('txn.amount')}
            required
            autoFocus={!txn}
            value={form.amount}
            onChange={(v) => set({ amount: v })}
            minorUnit={minor(account)}
            unit={from?.currency}
            helperText={form.type === 'adjustment' ? t('txn.adjustmentHint') : undefined}
          />
          <Box sx={two}>
            <TextField
              select
              required
              label={t(transfer ? 'txn.fromAccount' : 'txn.account')}
              value={byId.has(account) ? account : ''}
              onChange={(e) => choose('account', e.target.value)}
              disabled={openingBalance}
            >
              {accountOptions}
            </TextField>
            {transfer ? (
              <TextField
                select
                required
                label={t('txn.toAccount')}
                value={byId.has(form.toAccount) ? form.toAccount : ''}
                onChange={(e) => set({ toAccount: e.target.value })}
                error={!!form.toAccount && form.toAccount === account}
                helperText={form.toAccount && form.toAccount === account ? t('txn.sameAccount') : undefined}
              >
                {accountOptions}
              </TextField>
            ) : kind && (
              <CategoryPicker label={t('txn.category')} noneLabel={t('txn.noCategory')} options={options} value={form.category}
                onChange={(category) => choose('category', category)} />
            )}
          </Box>
          {crossCurrency && (
            <AmountField
              label={`${t('txn.amountReceived')} (${to?.currency})`}
              required
              value={form.amountReceived}
              onChange={(v) => set({ amountReceived: v })}
              minorUnit={minor(form.toAccount)}
              unit={to?.currency}
            />
          )}
          {transfer && kind && (
            <CategoryPicker label={t('txn.category')} noneLabel={t('txn.noCategory')} options={options} value={form.category}
              onChange={(category) => choose('category', category)} />
          )}
          <Box sx={{ ...two, gridTemplateColumns: '1fr 1fr' }}>
            <DateField label={t('txn.date')} required value={form.date} onChange={(date) => set({ date })} />
            <TimeField label={t('txn.time')} required value={form.time} onChange={(time) => set({ time })} />
          </Box>
          {card && !readOnly && (!txn || installments.isFetched) && (
            <InstallmentFields card={card} plan={plan} onChange={setPlan} purchaseDate={form.date}
              amount={entries ? Math.abs(entries[0].amount) : null} minorUnit={minor(card.id)} />
          )}
          {losesPlan && !readOnly && <Alert severity="warning">{t('plan.removedOnSave')}</Alert>}
          <TextField label={t('txn.payee')} value={form.payee} onChange={(e) => choose('payee', e.target.value)} />
          <TextField label={t('txn.note')} value={form.note} onChange={(e) => set({ note: e.target.value })} multiline minRows={1} maxRows={4}
            placeholder={t('common.optional')} />
          {txn?.created_by && (
            <Typography variant="body2" color="text.secondary">
              {t('txn.createdBy', { name: personName(txn.created_by, t), editor: personName(txn.modified_by, t) })}
            </Typography>
          )}
      {error ? <Alert severity={error instanceof ApiError && error.status === 409 ? 'warning' : 'error'}>{errorText(error)}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogFooter>
        {txn && (
          <>
            <Button startIcon={<HistoryIcon />} onClick={() => setShowHistory(true)}>
              {t('txn.history')}
            </Button>
            {!readOnly && (
              <Button color="error" startIcon={<DeleteIcon />} onClick={() => setConfirmDelete(true)}>
                {t('txn.delete')}
              </Button>
            )}
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        {!readOnly && (
          <Button type="submit" variant="contained" loading={busy} disabled={!ready}>
            {t('txn.save')}
          </Button>
        )}
      </DialogFooter>
      {extras}
    </Dialog>
  )
}

function toForm(txn: Transaction | null | undefined, book: Book, minorOf: (currency: string) => number, defaults?: TxnDefaults): Form {
  if (!txn) {
    return { type: 'expense', date: todayIn(book.timezone), time: timeIn(book.timezone), account: defaults?.account ?? '', toAccount: '', amount: '', amountReceived: '', category: '', payee: '', note: '' }
  }
  const lang = currentLanguage()
  const text = (e: Entry, signed = false) => amountText(signed ? e.amount : Math.abs(e.amount), minorOf(e.currency ?? ''), lang)
  const out = txn.entries.find((e) => e.amount < 0) ?? txn.entries[0]
  const into = txn.entries.find((e) => e !== out)
  const transfer = txn.type === 'transfer'
  return {
    type: txn.type,
    date: txn.occurred_on,
    time: txn.occurred_time.slice(0, 5),
    account: transfer ? out.account_id : txn.entries[0].account_id,
    toAccount: transfer && into ? into.account_id : '',
    amount: text(transfer ? out : txn.entries[0], txn.type === 'adjustment'),
    amountReceived: transfer && into ? text(into) : '',
    category: txn.category_id ?? '',
    payee: txn.payee ?? '',
    note: txn.note ?? '',
  }
}
