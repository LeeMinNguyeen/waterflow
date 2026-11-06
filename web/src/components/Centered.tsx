import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

export function Centered({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100dvh', px: { xs: 3, sm: 2 }, pt: { xs: 12, sm: '150px' }, pb: 6 }}>
      <Box sx={{ width: '100%', maxWidth: 360, mx: 'auto' }}>{children}</Box>
    </Box>
  )
}
