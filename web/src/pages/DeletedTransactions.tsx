import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogFooter } from '../components/DialogFooter'
import { useErrorText } from '../components/errors'
import { Money } from '../components/Money'
import { useRestoreTxn } from '../components/restoreTxn'
import { currentLanguage } from '../i18n'
import { api, type Book, type DeletedTxn } from '../lib/api'
import { useAccounts, useCategories } from '../lib/queries'

export function DeletedTransactions({ book, onClose }: { book: Book; onClose: () => void }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const restore = useRestoreTxn(book.id)
  const [busy, setBusy] = useState<string | null>(null)
  const gone = useQuery({ queryKey: ['books', book.id, 'transactions', 'deleted'],
    queryFn: () => api<DeletedTxn[]>(`/v1/books/${book.id}/transactions/deleted`) })
  const accounts = new Map((useAccounts(book.id, true).data ?? []).map((a) => [a.id, a.name]))
  const categories = new Map((useCategories(book.id, true).data ?? []).map((c) => [c.id, c.name]))
  const day = new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const canEdit = book.role !== 'viewer'

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="deleted-title">
      <DialogTitle id="deleted-title">{t('txn.recentlyDeleted')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="textSecondary">{t('txn.deletedKept')}</Typography>
        {gone.isError && <Alert severity="error" sx={{ mt: 2 }}>{errorText(gone.error)}</Alert>}
        {gone.data?.length === 0 && <Typography sx={{ mt: 2 }}>{t('txn.noneDeleted')}</Typography>}
        <List disablePadding sx={{ mt: 1 }}>
          {gone.data?.map((g) => {
            const out = (g.type === 'transfer' ? g.entries.find((e) => e.amount < 0) : g.entries[0]) ?? g.entries[0]
            return (
              <ListItem key={g.id} divider disableGutters sx={{ gap: 1.5 }}>
                <ListItemText primary={g.payee || t(`txn.types.${g.type}`)}
                  secondary={[day.format(new Date(`${g.occurred_on}T00:00:00`)), g.category_id && categories.get(g.category_id),
                    g.entries.map((e) => accounts.get(e.account_id)).filter(Boolean).join(' → '),
                    g.deleted_by && t('txn.deletedBy', { name: g.deleted_by })].filter(Boolean).join(' · ')} />
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
                  {out && <Money amount={out.amount} currency={out.currency ?? book.base_currency} kind={g.type === 'transfer' ? 'transfer' : 'flow'} sign />}
                  {canEdit && (
                    <Button size="small" loading={busy === g.id} disabled={!!busy && busy !== g.id}
                      onClick={async () => { setBusy(g.id); await restore(g.id); setBusy(null) }}>
                      {t('txn.restore')}
                    </Button>
                  )}
                </Stack>
              </ListItem>
            )
          })}
        </List>
      </DialogContent>
      <DialogFooter>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
