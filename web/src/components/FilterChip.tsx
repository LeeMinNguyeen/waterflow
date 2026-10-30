import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ButtonBase from '@mui/material/ButtonBase'
import type { MouseEvent } from 'react'

export function FilterChip({ label, value, onClick }: { label: string; value?: string; onClick: (e: MouseEvent<HTMLElement>) => void }) {
  const on = !!value
  return (
    <ButtonBase onClick={onClick} aria-label={on ? `${label}: ${value}` : label} aria-haspopup="true"
      sx={(theme) => ({
        height: 32, px: 1.5, gap: 0.5, borderRadius: 999, flexShrink: 0, whiteSpace: 'nowrap', fontSize: 13, fontWeight: on ? 500 : 400,
        border: 1, borderColor: on ? theme.palette.accentSoft : theme.palette.lineStrong,
        bgcolor: on ? theme.palette.accentSoft : 'transparent', color: on ? 'primary.main' : 'text.secondary',
        '&:hover': { bgcolor: on ? theme.palette.accentSoft : 'background.subtle' },
        '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 },
      })}>
      {on ? value : label}
      <ExpandMoreIcon sx={{ fontSize: 16 }} />
    </ButtonBase>
  )
}
