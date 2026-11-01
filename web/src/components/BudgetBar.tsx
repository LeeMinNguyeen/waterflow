import ButtonBase from '@mui/material/ButtonBase'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import { Bar } from './Bar'

type Props = {
  spent: number; budget: number; percent: number; label: string; color?: string | null; format: (minor: number) => string
  onClick?: () => void
}

// Past the limit the bar turns red and says "over" in words, so the state never rests on colour alone.
export function BudgetBar({ spent, budget, percent, label, color, format, onClick }: Props) {
  const { t } = useTranslation()
  const over = spent > budget
  const bar = (
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
  if (!onClick) return bar
  // Inside a row that opens something else (Categories), a press on the bar is the bar's alone.
  const own = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    <ButtonBase component="div" onClick={(e) => { own(e); onClick() }} onMouseDown={own} onTouchStart={own}
      sx={{ display: 'block', width: '100%', textAlign: 'inherit', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' },
        '&.Mui-focusVisible': { bgcolor: 'action.focus' }, '@media (hover: none)': { '&:hover': { bgcolor: 'transparent' } } }}>
      {bar}
    </ButtonBase>
  )
}
