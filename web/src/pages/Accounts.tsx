import AddIcon from '@mui/icons-material/Add'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableRow from '@mui/material/TableRow'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { send, type Account, type AccountKind, type Book } from '../lib/api'
import { groupByKind, type AccountGroup } from '../lib/accounts'
import { formatMoney } from '../lib/money'
import { currencyLabel } from '../lib/labels'
import { useAccounts, useCurrencies } from '../lib/queries'
import { AccountDialog } from './AccountDialog'
import { Money } from '../components/Money'
import { PageHeader } from '../components/Page'

// A table on desktop, a list on phones. An account opens its details, which
// lead to its transactions.
export function Accounts({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const accounts = useAccounts(book.id, showArchived)
  const currencies = useCurrencies()
  const [dialog, setDialog] = useState<{ account: Account | null; editing: boolean } | null>(null)
  const [menu, setMenu] = useState<{ el: HTMLElement | null; id: string } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [folded, setFolded] = useState<Set<AccountKind>>(new Set())
  const canEdit = book.role !== 'viewer'
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const navigate = useNavigate()
  const open = (a: Account) => setDialog({ account: a, editing: false })
  const transactions = (a: Account) => navigate(`/books/${book.id}/transactions?account_id=${a.id}`)

  const mine = accounts.data?.filter((a) => a.kind !== 'person')
  const groups = groupByKind(mine ?? [])
  const toggle = (kind: AccountKind) => setFolded((f) => {
    const next = new Set(f)
    if (!next.delete(kind)) next.add(kind)
    return next
  })
  const foldButton = (kind: AccountKind) => (
    <IconButton size="small" aria-label={t('accounts.fold', { kind: t(`accounts.kinds.${kind}`) })} aria-expanded={!folded.has(kind)}
      onClick={(e) => { e.stopPropagation(); toggle(kind) }}>
      {folded.has(kind) ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
    </IconButton>
  )
  const menuButton = (a: Account, edge?: 'end') => (
    <IconButton edge={edge} size="small" aria-label={t('accounts.actions')} onClick={(e) => setMenu({ el: e.currentTarget, id: a.id })}>
      <MoreVertIcon fontSize="small" />
    </IconButton>
  )
  const menuAccount = menu ? accounts.data?.find((a) => a.id === menu.id) : undefined
  const closeMenu = () => setMenu((m) => m && { ...m, el: null })
  const groupTotal = (g: AccountGroup) => (
    <>
      <Money amount={g.total} currency={book.base_currency} kind="balance" variant={desktop ? 'body1' : 'body2'}
        sx={{ fontWeight: desktop ? 500 : 400, display: 'block', ...(!desktop && g.total >= 0 && { color: 'text.disabled' }) }} />
      {g.notIncluded > 0 && <Typography variant="caption" color="textDisabled">{t('accounts.notIncluded', { count: g.notIncluded })}</Typography>}
    </>
  )

  async function setPinned(account: Account, pinned: boolean) {
    closeMenu()
    setError(null)
    try {
      await send(pinned ? 'PUT' : 'DELETE', `/v1/books/${book.id}/accounts/${account.id}/pin`)
    } catch (err) {
      setError(err)
    }
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'accounts'] })
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'dashboard'] })
  }

  async function setArchived(account: Account, archived: boolean) {
    closeMenu()
    setError(null)
    try {
      await send('PATCH', `/v1/books/${book.id}/accounts/${account.id}`, { version: account.version, archived })
    } catch (err) {
      setError(err)
    }
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'accounts'] })
  }

  const converted = (a: Account) =>
    a.currency !== book.base_currency && (
      <Typography variant="caption" color="textDisabled" component="div" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {a.converted_balance == null ? t('dash.noRate') : `≈ ${formatMoney(a.converted_balance, book.base_currency, currencies.data?.get(book.base_currency)?.minor_unit ?? 0, currentLanguage())}`}
      </Typography>
    )
  const meta = (a: Account) => [t(`accounts.kinds.${a.kind}`), a.last4 && `•••• ${a.last4}`, !a.in_net_worth && t('accounts.notInNetWorth')]
    .filter(Boolean).join(' · ')
  const dim = (a: Account) => (a.in_net_worth && !a.archived_at ? 1 : 0.55)

  return (
    <Box sx={{ maxWidth: 920 }}>
      <PageHeader title={t('accounts.title')} bookId={book.id}>
        {canEdit && (
          <Button variant="outlined" size={desktop ? 'medium' : 'small'} startIcon={<AddIcon />} onClick={() => setDialog({ account: null, editing: true })}>
            {t('accounts.add')}
          </Button>
        )}
      </PageHeader>
      {error ? <Alert severity="error" sx={{ mt: 2 }}>{errorText(error)}</Alert> : null}
      {accounts.isError && !accounts.data ? <Alert severity="error" sx={{ mt: 2 }}>{errorText(accounts.error)}</Alert> : null}
      {mine?.length === 0 && <Typography color="textSecondary" sx={{ mt: 3 }}>{t('accounts.empty')}</Typography>}
      {desktop && mine && mine.length > 0 && (
        <Table sx={{ mt: 1, '& td': { borderColor: 'divider' } }}>
          <TableBody>
            {groups.map((g) => (
              <Fragment key={g.kind}>
                <TableRow data-group={g.kind} onClick={() => toggle(g.kind)} sx={{ cursor: 'pointer' }}>
                  <TableCell colSpan={3} sx={{ pt: 3.5, pb: 1, px: 0 }}>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      {foldButton(g.kind)}
                      <Typography variant="h2">
                        {t(`accounts.kinds.${g.kind}`)}
                        <Box component="span" sx={{ fontWeight: 400, color: 'text.disabled' }}> · {g.accounts.length}</Box>
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="right" colSpan={2} sx={{ pt: 3.5, pb: 1, pr: 0 }}>{groupTotal(g)}</TableCell>
                </TableRow>
                {!folded.has(g.kind) && g.accounts.map((a) => (
                  <TableRow key={a.id} hover onClick={() => open(a)} sx={{ cursor: 'pointer', '& td': { py: 1.25 } }}>
                    <TableCell sx={{ px: 0, opacity: dim(a) }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography component="span">{a.name}</Typography>
                        {a.archived_at && <Chip size="small" label={t('accounts.archived')} />}
                      </Stack>
                      <Typography variant="body2" color="textSecondary">{meta(a)}</Typography>
                    </TableCell>
                    <TableCell sx={{ width: 64 }}>
                      {a.currency !== book.base_currency && (
                        <Box component="span" title={currencyLabel(a.currency, currencies.data?.get(a.currency)?.name)}
                          sx={{ display: 'inline-flex', height: 20, alignItems: 'center', px: 0.75, borderRadius: '5px', bgcolor: 'background.subtle',
                            fontSize: 11, fontWeight: 500, color: 'text.secondary', letterSpacing: '0.02em' }}>
                          {a.currency}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell sx={{ width: 24 }} />
                    <TableCell align="right" sx={{ width: 200, opacity: dim(a) }}>
                      <Money amount={a.balance} currency={a.currency} kind="balance" />
                      {converted(a)}
                    </TableCell>
                    <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>{menuButton(a)}</TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
      {!desktop && mine && mine.length > 0 && (
        <List disablePadding sx={{ mt: 1 }}>
          {groups.map((g) => (
            <Fragment key={g.kind}>
              <ListItem data-group={g.kind} disablePadding sx={{ borderBottom: 1, borderColor: 'divider', mt: 2 }}>
                <ListItemButton onClick={() => toggle(g.kind)} sx={{ px: 0, py: 0.5 }}>
                  <ListItemIcon sx={{ minWidth: 28 }}>{folded.has(g.kind) ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}</ListItemIcon>
                  <ListItemText primary={`${t(`accounts.kinds.${g.kind}`)} · ${g.accounts.length}`} slotProps={{ primary: { variant: 'body2', sx: { fontWeight: 600, color: 'text.secondary' } } }} />
                  <Box sx={{ textAlign: 'right', ml: 2 }}>{groupTotal(g)}</Box>
                </ListItemButton>
              </ListItem>
              {!folded.has(g.kind) && g.accounts.map((a) => (
                <ListItem key={a.id} disablePadding secondaryAction={menuButton(a, 'end')}
                  sx={{ '&:not(:last-of-type)': { borderBottom: 1, borderColor: 'divider' } }}>
                  {/* Left out of net worth: greyed out but still clickable */}
                  <ListItemButton onClick={() => open(a)} sx={{ px: 0, py: 0.75, minHeight: 56, opacity: dim(a), '& .MuiListItemText-root': { my: 0 } }}>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <span>{a.name}</span>
                          {a.archived_at && <Chip size="small" label={t('accounts.archived')} />}
                        </Stack>
                      }
                      secondary={a.currency !== book.base_currency ? `${meta(a)} · ${a.currency}` : meta(a)}
                    />
                    <Box sx={{ textAlign: 'right', ml: 2 }}>
                      <Money amount={a.balance} currency={a.currency} kind="balance" />
                      {converted(a)}
                    </Box>
                  </ListItemButton>
                </ListItem>
              ))}
            </Fragment>
          ))}
        </List>
      )}
      <FormControlLabel sx={{ mt: 3 }}
        control={<Switch size="small" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />}
        label={<Typography variant="body2" color="textSecondary">{t('accounts.showArchived')}</Typography>}
      />
      <Menu anchorEl={menu?.el} open={!!menu?.el && !!menuAccount} onClose={closeMenu}>
        {menuAccount && [
          <MenuItem key="pin" onClick={() => setPinned(menuAccount, !menuAccount.pinned)}>
            {t(menuAccount.pinned ? 'accounts.unpin' : 'accounts.pin')}
          </MenuItem>,
          canEdit && (
            <MenuItem key="edit" onClick={() => { setDialog({ account: menuAccount, editing: true }); closeMenu() }}>
              {t('accounts.edit')}
            </MenuItem>
          ),
          canEdit && (
            <MenuItem key="archive" onClick={() => setArchived(menuAccount, !menuAccount.archived_at)}>
              {t(menuAccount.archived_at ? 'accounts.unarchive' : 'accounts.archive')}
            </MenuItem>
          ),
        ]}
      </Menu>
      {dialog && (
        <AccountDialog key={dialog.account?.id ?? 'new'} book={book} account={dialog.account} editing={dialog.editing}
          onTransactions={transactions} onClose={() => setDialog(null)} />
      )}
    </Box>
  )
}
