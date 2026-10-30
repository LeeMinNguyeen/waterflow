import Box from '@mui/material/Box'

export function Bar({ label, percent, color }: { label: string; percent: number; color: string }) {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <Box role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}
      sx={{ height: 4, borderRadius: '2px', bgcolor: 'divider' }}>
      <Box sx={{ height: 4, borderRadius: '2px', width: `${value}%`, bgcolor: color }} />
    </Box>
  )
}
