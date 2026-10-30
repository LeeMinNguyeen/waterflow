import Box, { type BoxProps } from '@mui/material/Box'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useId, type ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'
import { RefreshButton } from './RefreshButton'

export function PageHeader({ title, bookId, children }: { title: string; bookId?: string; children?: ReactNode }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, minHeight: 36, flexWrap: 'wrap' }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Typography variant="h1" noWrap>{title}</Typography>
        {bookId && <RefreshButton bookId={bookId} />}
      </Stack>
      {children}
    </Stack>
  )
}

export function Section({ title, action, children, ...props }: { title: string; action?: ReactNode; children: ReactNode } & BoxProps) {
  const id = useId()
  return (
    <Box component="section" aria-labelledby={id} {...props} sx={[{ minWidth: 0 }, ...(Array.isArray(props.sx) ? props.sx : [props.sx])]}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 2, mb: 1.5 }}>
        <Typography id={id} variant="h2">{title}</Typography>
        {action}
      </Stack>
      {children}
    </Box>
  )
}

export function SeeAll({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link component={RouterLink} to={to} variant="body2" color="text.secondary" underline="hover" sx={{ whiteSpace: 'nowrap' }}>
      {children}
    </Link>
  )
}
