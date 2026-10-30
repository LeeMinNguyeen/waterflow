import CloseIcon from '@mui/icons-material/Close'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import type { MouseEvent } from 'react'

export function FilterChip({ label, value, onClick, onClear, clearLabel }: {
  label: string; value?: string; onClick: (e: MouseEvent<HTMLElement>) => void; onClear: () => void; clearLabel: string
}) {
  const on = !!value
  return (
    <Box sx={(theme) => ({
      display: 'inline-flex', alignItems: 'center', height: 36, borderRadius: 999, flexShrink: 0, border: 1, overflow: 'hidden',
      borderColor: on ? theme.palette.accentSoft : theme.palette.lineStrong, bgcolor: on ? theme.palette.accentSoft : 'transparent',
      color: on ? 'primary.main' : 'text.secondary',
      '& .MuiButtonBase-root.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
    })}>
      <ButtonBase onClick={onClick} aria-label={on ? `${label}: ${value}` : label} aria-haspopup="true"
        sx={{ height: '100%', pl: 1.5, pr: on ? 0.5 : 1.5, gap: 0.5, whiteSpace: 'nowrap', fontSize: 13, fontWeight: on ? 500 : 400,
          '&:hover': { bgcolor: on ? undefined : 'background.subtle' } }}>
        {on ? value : label}
        {!on && <ExpandMoreIcon sx={{ fontSize: 16 }} />}
      </ButtonBase>
      {on && (
        <ButtonBase onClick={onClear} aria-label={clearLabel} sx={{ height: '100%', pl: 0.25, pr: 1.25 }}>
          <CloseIcon sx={{ fontSize: 14 }} />
        </ButtonBase>
      )}
    </Box>
  )
}
