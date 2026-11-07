import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'
import { useCallback, useState, type ReactNode } from 'react'
import { ToastContext, type ToastAction } from '../lib/toast'

// Centred, clear of the desktop sidebar; on phones above the bottom bar (56 px) and the add button (56 px).
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; key: number; action?: ToastAction } | null>(null)
  const show = useCallback((text: string, action?: ToastAction) => setToast({ text, key: Date.now(), action }), [])
  const action = toast?.action
  return (
    <ToastContext.Provider value={show}>
      {children}
      <Snackbar key={toast?.key} open={!!toast} message={toast?.text} autoHideDuration={action ? 6000 : 3000}
        action={action && <Button color="inherit" size="small" onClick={() => { setToast(null); action.run() }}>{action.label}</Button>}
        onClose={(_, reason) => { if (reason !== 'clickaway') setToast(null) }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 'calc(136px + env(safe-area-inset-bottom))', md: 24 } }} />
    </ToastContext.Provider>
  )
}
