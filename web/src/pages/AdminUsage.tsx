import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar } from '../components/Bar'
import { DialogFooter } from '../components/DialogFooter'
import { FormSection, Section } from '../components/Page'
import { Stat } from '../components/Stat'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { api, send } from '../lib/api'

type KeepDays = 30 | 90 | 180 | 365
const KEEP_DAYS: KeepDays[] = [30, 90, 180, 365]
type Usage = {
  collecting: boolean; keep_days: KeepDays; since: string | null
  people: { accounts: number; new_this_month: number; today: number; days_7: number; days_30: number }
  days: { day: string; people: number }[]
  features: { feature: string; people: number; times: number }[]
  server: { books: number; shared_books: number }
}

const usageKey = ['admin', 'usage']

export function AdminUsage() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const usage = useQuery({ queryKey: usageKey, queryFn: () => api<Usage>('/v1/admin/usage') })
  const [error, setError] = useState<unknown>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!usage.data) return usage.isError ? <Alert severity="error">{errorText(usage.error)}</Alert> : null
  const u = usage.data
  const hasNumbers = u.since !== null || u.features.length > 0 || u.days.some((d) => d.people > 0)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await Promise.all([qc.invalidateQueries({ queryKey: usageKey }), qc.invalidateQueries({ queryKey: ['instance'] })])
      setConfirming(false)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const collecting = (
    <FormSection title={t('usage.collecting')}>
      <Box>
        <FormControlLabel label={t('usage.collect')} sx={{ ml: '-12px', height: 36 }}
          control={<Switch checked={u.collecting} disabled={busy} onChange={(e) => run(() => send('PATCH', '/v1/admin/instance', { usage_stats: e.target.checked ? 'on' : 'off' }))} />} />
      </Box>
      <TextField select label={t('usage.keepFor')} value={u.keep_days} disabled={!u.collecting || busy} sx={{ width: 240 }}
        onChange={(e) => run(() => send('PATCH', '/v1/admin/instance', { usage_keep_days: Number(e.target.value) }))}>
        {KEEP_DAYS.map((d) => <MenuItem key={d} value={d}>{t('usage.keepDays', { count: d })}</MenuItem>)}
      </TextField>
      {hasNumbers && (
        <Box><Button color="error" onClick={() => { setError(null); setConfirming(true) }} sx={{ ml: -1.75 }}>{t('usage.delete')}</Button></Box>
      )}
      {error && !confirming ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Typography variant="caption" color="textDisabled" sx={{ maxWidth: 560 }}>{t(hasNumbers ? 'usage.note' : 'usage.offNote')}</Typography>
      <Dialog open={confirming} onClose={() => { if (!busy) { setError(null); setConfirming(false) } }} fullWidth maxWidth="xs">
        <DialogTitle>{t('usage.deleteTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('usage.deleteBody')}</DialogContentText>
          {error ? <Alert severity="error" sx={{ mt: 2 }}>{errorText(error)}</Alert> : null}
        </DialogContent>
        <DialogFooter>
          <Button disabled={busy} onClick={() => { setError(null); setConfirming(false) }}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" loading={busy} onClick={() => run(() => send('DELETE', '/v1/admin/usage'))}>{t('usage.deleteConfirm')}</Button>
        </DialogFooter>
      </Dialog>
    </FormSection>
  )

  if (!hasNumbers && !u.collecting) {
    return (
      <Stack spacing={4} sx={{ pt: 4 }}>
        <Box component="section">
          <Typography variant="h2" sx={{ fontSize: 18, lineHeight: '24px', mb: 1.5 }}>{t('usage.offTitle')}</Typography>
          <Typography color="textSecondary" sx={{ maxWidth: 640 }}>{t('usage.offBody')}</Typography>
        </Box>
        {collecting}
      </Stack>
    )
  }

  return (
    <Stack spacing={4} sx={{ pt: 3.5 }}>
      <Box sx={{ display: { xs: 'grid', md: 'flex' }, gridTemplateColumns: '1fr 1fr', gap: { xs: '20px 16px', md: 8 }, pb: { xs: 2.5, md: 4 }, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ gridColumn: { xs: '1 / 3', md: 'auto' } }}><Stat label={t('usage.accounts')} value={u.people.accounts} /></Box>
        <Stat label={t('usage.today')} value={u.people.today} />
        <Stat label={t('usage.days7')} value={u.people.days_7} />
        <Stat label={t('usage.days30')} value={u.people.days_30} />
        <Stat label={t('usage.newMonth')} value={u.people.new_this_month} />
      </Box>
      <DaysChart days={u.days} />
      <Section title={t('usage.features')}>
        <Stack>
          {u.features.map((f) => {
            const name = t(`usage.feature.${f.feature}`, { defaultValue: f.feature })
            return (
              <Box key={f.feature} sx={{ display: { md: 'flex' }, alignItems: 'center', gap: { md: 3 }, py: { xs: 1, md: 0 }, minHeight: { md: 36 } }}>
                <Typography noWrap sx={{ width: { md: 220 }, flex: { md: 'none' } }}>{name}</Typography>
                <Typography variant="body2" color="textSecondary"
                  sx={{ order: { md: 3 }, width: { md: 180 }, flex: { md: 'none' }, textAlign: { md: 'right' }, fontVariantNumeric: 'tabular-nums', mt: { xs: 0.25, md: 0 }, mb: { xs: 1, md: 0 } }}>
                  {t('usage.people', { count: f.people })} · {t('usage.times', { count: f.times })}
                </Typography>
                <Box sx={{ flex: { md: 1 } }}>
                  <Bar label={name} color="primary.main" percent={Math.max(1, (f.people / Math.max(1, u.people.days_30)) * 100)} />
                </Box>
              </Box>
            )
          })}
        </Stack>
      </Section>
      <FormSection title={t('usage.server')}>
        <Box sx={{ display: 'flex', gap: { xs: 2, md: 8 }, '& > *': { width: { xs: 'calc(50% - 8px)', md: 'auto' } } }}>
          <Stat label={t('usage.books')} value={u.server.books} />
          <Stat label={t('usage.shared')} value={u.server.shared_books} />
        </Box>
      </FormSection>
      {collecting}
    </Stack>
  )
}

function DaysChart({ days }: { days: Usage['days'] }) {
  const { t } = useTranslation()
  const fmt = new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const date = (day: string) => fmt.format(new Date(`${day}T00:00:00Z`))
  const max = Math.max(1, ...days.map((d) => d.people))
  return (
    <Section title={t('usage.chart')}>
      <Box sx={{ height: { xs: 80, md: 96 }, display: 'flex', alignItems: 'flex-end', gap: { xs: '3px', md: '6px' } }}>
        {days.map((d) => {
          const label = t('usage.bar', { date: date(d.day), count: d.people })
          return (
            <Box key={d.day} title={label} aria-label={label} role="img" sx={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
              <Box sx={{ width: '100%', borderRadius: '2px 2px 0 0', height: d.people ? `${Math.max(4, (d.people / max) * 100)}%` : '4%', bgcolor: d.people ? 'primary.main' : 'divider' }} />
            </Box>
          )
        })}
      </Box>
      {days.length > 0 && (
        <Stack direction="row" sx={{ justifyContent: 'space-between', mt: 0.75 }}>
          <Typography variant="caption" color="textDisabled">{date(days[0].day)}</Typography>
          <Typography variant="caption" color="textDisabled">{date(days[days.length - 1].day)}</Typography>
        </Stack>
      )}
    </Section>
  )
}
