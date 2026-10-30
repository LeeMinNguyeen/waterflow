import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import { Bar } from './Bar'

type Props = { spent: number; budget: number; percent: number; label: string; color?: string | null; format: (minor: number) => string }

// Past the limit the bar turns red and says "over" in words, so the state never rests on colour alone.
export function BudgetBar({ spent, budget, percent, label, color, format }: Props) {
  const { t } = useTranslation()
  const over = spent > budget
  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
        <Typography noWrap>{label}</Typography>
        <Typography variant="body2" color={over ? 'error' : 'textSecondary'} sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {over ? t('budget.over', { amount: format(spent - budget) }) : t('budget.progress', { spent: format(spent), budget: format(budget) })}
        </Typography>
      </Stack>
      <Bar label={label} percent={percent} color={over ? 'error.main' : color || 'text.disabled'} />
    </Stack>
  )
}
