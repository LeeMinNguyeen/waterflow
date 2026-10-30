import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useInstance } from '../lib/queries'
import { useErrorText } from './errors'
import { LanguagePicker } from './LanguagePicker'

// The title row of every screen before sign-in: the server's name and, where asked, the language dropdown.
export function PublicHeader({ title, languageSwitch = true }: { title: string; languageSwitch?: boolean }) {
  const instance = useInstance()
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center', minHeight: 22 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 15, letterSpacing: '-0.01em' }}>{instance.data?.name}</Typography>
        {languageSwitch && <LanguagePicker size="small" />}
      </Stack>
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
