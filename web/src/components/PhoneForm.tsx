import MoreHorizIcon from '@mui/icons-material/MoreHoriz'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase, { type ButtonBaseProps } from '@mui/material/ButtonBase'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import ListItemButton from '@mui/material/ListItemButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Category } from '../lib/api'

export function Sheet({ open, title, onClose, done, children }: {
  open: boolean; title: string; onClose: () => void; done?: () => void; children: ReactNode
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <Drawer anchor="bottom" open={open} onClose={onClose} sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
      slotProps={{ paper: { role: 'dialog', 'aria-labelledby': id, sx: { borderTopLeftRadius: 14, borderTopRightRadius: 14, maxHeight: '85dvh',
        pb: 'env(safe-area-inset-bottom)' } } }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2.5, pt: 2.5, pb: 1 }}>
        <Typography id={id} sx={{ fontSize: 20, fontWeight: 600 }}>{title}</Typography>
        {done && <Button onClick={done} sx={{ color: 'primary.main', fontWeight: 600 }}>{t('common.done')}</Button>}
      </Stack>
      <Box sx={{ overflowY: 'auto', px: 2.5, pb: 2 }}>{children}</Box>
    </Drawer>
  )
}

export function PickRow({ label, value, placeholder, onClick, disabled }: {
  label: string; value?: ReactNode; placeholder?: string; onClick: () => void; disabled?: boolean
}) {
  return (
    <ButtonBase onClick={onClick} disabled={disabled}
      sx={{ display: 'block', width: '100%', textAlign: 'left', py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
      <Typography variant="caption" color="text.disabled" component="div">{label}</Typography>
      <Typography component="div" sx={{ fontSize: 17, color: value ? 'text.primary' : 'text.disabled', mt: 0.25 }}>{value || placeholder}</Typography>
    </ButtonBase>
  )
}

export function Pill({ children, selected = false, color = 'primary.main', look = 'soft', sx, ...props }: ButtonBaseProps & {
  selected?: boolean; color?: string; look?: 'soft' | 'outlined' | 'filled'
}) {
  return (
    <ButtonBase {...props}
      sx={[(theme) => ({
        minHeight: 40, px: 2, borderRadius: 999, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        display: 'block', border: 1, borderColor: 'transparent', color: 'text.primary', bgcolor: theme.palette.background.subtle,
        ...(look === 'outlined' && { bgcolor: 'transparent', borderColor: selected ? color : theme.palette.lineStrong, color: selected ? color : 'text.primary' }),
        ...(look === 'filled' && selected && { bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 500 }),
        ...(look === 'filled' && !selected && { color: 'text.secondary' }),
        '&.Mui-disabled': { opacity: 0.5 },
      }), ...(Array.isArray(sx) ? sx : [sx])]}>
      {children}
    </ButtonBase>
  )
}

type Row = { category: Category; depth: number; path: string }

export function CategoryPills({ rows, value, onChange, color, noneLabel, disabled }: {
  rows: Row[]; value: string; onChange: (id: string) => void; color: string; noneLabel: string; disabled?: boolean
}) {
  const { t } = useTranslation()
  const [sheet, setSheet] = useState<'all' | string | null>(null)
  const [search, setSearch] = useState('')
  const tops = rows.filter((r) => r.depth === 0)
  const branch = (topId: string) => {
    const start = rows.findIndex((r) => r.category.id === topId)
    const end = rows.findIndex((r, i) => i > start && r.depth === 0)
    return rows.slice(start, end === -1 ? undefined : end)
  }
  const topOf = (id: string) => tops.find((top) => branch(top.category.id).some((r) => r.category.id === id))
  const chosen = rows.find((r) => r.category.id === value)
  const chosenTop = value ? topOf(value) : undefined
  const pick = (id: string) => {
    onChange(id)
    setSheet(null)
    setSearch('')
  }
  const sheetRows = sheet === 'all'
    ? rows.filter((r) => r.path.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    : sheet ? branch(sheet) : []

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.25 }}>
      {tops.map(({ category: c }) => {
        const on = chosenTop?.category.id === c.id
        const children = branch(c.id).length > 1
        return (
          <Box key={c.id} sx={{ position: 'relative', minWidth: 0 }}>
            <Pill look="outlined" color={color} selected={on} aria-pressed={on} disabled={disabled} sx={{ width: '100%' }}
              onClick={() => (on && children ? setSheet(c.id) : onChange(c.id))}>
              {on && chosen ? chosen.category.name : c.name}
            </Pill>
            {on && children && !disabled && (
              <IconButton size="small" aria-label={t('txn.subcategoriesOf', { name: c.name })} onClick={() => setSheet(c.id)}
                sx={{ position: 'absolute', right: -6, bottom: -6, width: 22, height: 22, bgcolor: color, color: 'background.default',
                  '&:hover': { bgcolor: color } }}>
                <MoreHorizIcon sx={{ fontSize: 16 }} />
              </IconButton>
            )}
          </Box>
        )
      })}
      <Pill look="outlined" disabled={disabled} onClick={() => setSheet('all')} sx={{ color: 'text.secondary' }}>{t('txn.allCategories')}</Pill>
      <Sheet open={sheet !== null} title={sheet === 'all' ? t('txn.category') : rows.find((r) => r.category.id === sheet)?.category.name ?? ''}
        onClose={() => { setSheet(null); setSearch('') }}>
        {sheet === 'all' && (
          <TextField size="small" autoFocus placeholder={t('txn.searchCategories')} value={search} onChange={(e) => setSearch(e.target.value)}
            slotProps={{ htmlInput: { 'aria-label': t('txn.searchCategories') } }} sx={{ mb: 1 }} />
        )}
        {sheet === 'all' && !search && (
          <ListItemButton onClick={() => pick('')} selected={!value} sx={{ px: 0, minHeight: 52 }}>{noneLabel}</ListItemButton>
        )}
        {sheetRows.map(({ category: c, depth, path }) => (
          <ListItemButton key={c.id} onClick={() => pick(c.id)} selected={c.id === value}
            sx={{ px: 0, pl: sheet === 'all' && search ? 0 : depth * 2.5, minHeight: 52, gap: 1.5, borderTop: 1, borderColor: 'divider' }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: c.color || 'text.disabled' }} />
            {sheet === 'all' && search ? path : c.name}
          </ListItemButton>
        ))}
      </Sheet>
    </Box>
  )
}
