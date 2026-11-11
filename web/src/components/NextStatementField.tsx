import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'

type Props = { checked: boolean; closes: string; onChange: (checked: boolean) => void }

export function NextStatementField({ checked, closes, onChange }: Props) {
  const { t } = useTranslation()
  const day = new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium' })
  return (
    <Stack>
      <FormControlLabel label={t('txn.nextStatement')} sx={{ ml: 0 }}
        control={<Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />} />
      {checked && (
        <Typography variant="body2" color="textSecondary" sx={{ pl: '42px' }}>
          {t('txn.nextStatementCloses', { date: day.format(new Date(`${closes}T00:00:00`)) })}
        </Typography>
      )}
    </Stack>
  )
}
