import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useInstance } from '../lib/queries'
import { Centered } from './Centered'
import { useErrorText } from './errors'
import { LanguageMenu } from './LanguageMenu'

// A screen before sign-in with the language button at the window's top right, clear of the form on a phone too.
export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ position: 'relative' }}>
      <Box sx={{ position: 'absolute', top: { xs: 12, sm: 16 }, right: { xs: 12, sm: 16 } }}>
        <LanguageMenu />
      </Box>
      <Centered>{children}</Centered>
    </Box>
  )
}

// The title row of every screen before sign-in.
export function PublicHeader({ title }: { title: string }) {
  const instance = useInstance()
  return (
    <Stack spacing={1.5}>
      <Typography sx={{ fontWeight: 600, fontSize: 15, letterSpacing: '-0.01em', minHeight: 22 }}>{instance.data?.name}</Typography>
      <Typography variant="h1">{title}</Typography>
    </Stack>
  )
}

// Username, password (twice) and display name for a new account: setup and join.
export function NewAccountFields() {
  const { t } = useTranslation()
  return (
    <>
      <TextField name="username" label={t('auth.username')} required autoComplete="username"
        helperText={t('welcome.usernameHint')}
        slotProps={{ htmlInput: { pattern: '[A-Za-z0-9][A-Za-z0-9_.]{2,29}', autoCapitalize: 'none' } }} />
      <TextField name="display_name" label={t('welcome.displayName')} />
      <PasswordFields />
    </>
  )
}

export function PasswordFields({ label }: { label?: string }) {
  const { t } = useTranslation()
  return (
    <>
      <TextField name="password" label={label ?? t('auth.password')} type="password" required autoComplete="new-password"
        helperText={t('auth.passwordHint')} slotProps={{ htmlInput: { minLength: 10, maxLength: 256 } }} />
      <TextField name="password2" label={t('auth.passwordAgain')} type="password" required autoComplete="new-password" />
    </>
  )
}

export function FormError({ error }: { error: unknown }): ReactNode {
  const errorText = useErrorText()
  return error ? <Alert severity="error">{errorText(error)}</Alert> : null
}
