import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import type { Account } from '../lib/api'
import { planDates, validMonths, type PlanForm } from '../lib/installments'
import { Money } from './Money'
import { AmountField } from './AmountField'
import { DateField } from './DateField'

type Props = {
  card: Account
  plan: PlanForm
  onChange: (patch: Partial<PlanForm>) => void
  purchaseDate: string
  amount: number | null // the purchase in minor units, positive
  minorUnit: number
}

export function InstallmentFields({ card, plan, onChange, purchaseDate, amount, minorUnit }: Props) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const { convertedOn: converted, firstStatement: first, statements } = planDates(plan, purchaseDate, card.statement_day)
  const dateFmt = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium' })
  const months = validMonths(plan.months) ? Number(plan.months) : null
  const each = amount && months ? Math.floor(amount / months) : null
  return (
    <Stack spacing={2}>
      <FormControlLabel
        control={<Switch checked={plan.on} disabled={!card.statement_day} onChange={(e) => onChange({ on: e.target.checked })} />}
        label={t('plan.switch')}
      />
      {!card.statement_day && <Typography variant="body2" color="textSecondary">{t('plan.needsStatementDay')}</Typography>}
      {plan.on && (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField type="number" required label={t('plan.months')} value={plan.months} error={!months}
              onChange={(e) => onChange({ months: e.target.value })} slotProps={{ htmlInput: { min: 2, max: 60 } }}
              sx={{ maxWidth: { sm: 110 } }} />
            <DateField label={t('plan.convertedOn')} required value={converted}
              onChange={(convertedOn) => onChange({ convertedOn, firstStatement: '' })} sx={{ maxWidth: { sm: 190 } }} />
            <TextField select label={t('plan.firstStatement')} value={first} onChange={(e) => onChange({ firstStatement: e.target.value })}
              sx={{ flex: 1 }}>
              {statements.map((d) => <MenuItem key={d} value={d}>{dateFmt.format(new Date(`${d}T00:00:00`))}</MenuItem>)}
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <AmountField label={t('plan.fee')} value={plan.fee} onChange={(fee) => onChange({ fee })} minorUnit={minorUnit} sx={{ flex: 1 }} />
            <TextField select label={t('plan.feeCharged')} value={plan.feeSplit ? 'split' : 'once'}
              onChange={(e) => onChange({ feeSplit: e.target.value === 'split' })} sx={{ flex: 1 }}>
              <MenuItem value="once">{t('plan.feeOnce')}</MenuItem>
              <MenuItem value="split">{t('plan.feeSplit')}</MenuItem>
            </TextField>
          </Stack>
          <FormControlLabel
            control={<Switch checked={plan.countsTowardLimit} onChange={(e) => onChange({ countsTowardLimit: e.target.checked })} />}
            label={t('plan.countsTowardLimit')}
          />
          {each !== null && months && (
            <Typography variant="body2" color="textSecondary">
              {months} × <Money amount={each} currency={card.currency} kind="balance" quiet />
            </Typography>
          )}
        </>
      )}
    </Stack>
  )
}
