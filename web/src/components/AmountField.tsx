import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import TextField, { type TextFieldProps } from '@mui/material/TextField'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { groupWhileTyping, parseAmount } from '../lib/money'

type Props = Omit<TextFieldProps, 'value' | 'onChange'> & {
  value: string
  onChange: (text: string) => void
  minorUnit: number
  big?: boolean
  unit?: string
  ariaLabel?: string
  // The amount can be below zero: a ± button flips it, since a phone's number pad has no minus key.
  signed?: boolean
}

// Amount input: groups thousands while typing and reads the number by the
// language's separators ("1.250" in Vietnamese is one thousand two hundred fifty).
export function AmountField({ value, onChange, minorUnit, big = false, unit, ariaLabel, signed = false, sx, ...props }: Props) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const typed = value.trim()
  const bad = typed !== '' && !(signed && typed === '-') && parseAmount(value, minorUnit, lang) === null
  const end = unit || signed ? (
    <InputAdornment position="end" sx={{ fontWeight: 500 }}>
      {unit}
      {signed && (
        <IconButton edge="end" size="small" aria-label={t('common.flipSign')} disabled={props.disabled}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(typed.startsWith('-') ? typed.slice(1) : `-${typed}`)}
          sx={{ ml: unit ? 1 : 0, width: 32, height: 32, fontSize: 20, lineHeight: 1, color: 'text.secondary' }}>
          ±
        </IconButton>
      )}
    </InputAdornment>
  ) : undefined
  return (
    <TextField
      {...props}
      value={value}
      onChange={(e) => onChange(groupWhileTyping(e.target.value, lang))}
      error={bad || props.error}
      helperText={bad ? t('errors.amount') : props.helperText}
      sx={[big && { '& .MuiOutlinedInput-root': { minHeight: 56, borderRadius: '10px' },
        '& .MuiOutlinedInput-input': { fontSize: 28, lineHeight: '36px', fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' } },
      ...(Array.isArray(sx) ? sx : [sx])]}
      slotProps={{
        htmlInput: { inputMode: minorUnit ? 'decimal' : 'numeric', autoComplete: 'off', 'aria-label': ariaLabel },
        input: end ? { endAdornment: end } : undefined,
      }}
    />
  )
}
