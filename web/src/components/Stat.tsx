import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

export function Stat({ label, value, notes = [], big = false }: { label: string; value: ReactNode; notes?: ReactNode[]; big?: boolean }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="textSecondary">{label}</Typography>
      <Typography variant={big ? 'display' : 'h1'} component="p"
        sx={{ mt: 0.75, fontVariantNumeric: 'tabular-nums', ...(!big && { fontSize: { xs: 18, md: 24 }, lineHeight: { xs: '24px', md: '32px' } }) }}>
        {value}
      </Typography>
      {notes.filter(Boolean).map((note, i) => (
        <Typography key={i} variant="caption" color="textDisabled" component="p" sx={{ mt: 0.5 }}>{note}</Typography>
      ))}
    </Box>
  )
}
