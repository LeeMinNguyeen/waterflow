import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Stack from '@mui/material/Stack'
import TextField, { type TextFieldProps } from '@mui/material/TextField'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { useHideAmounts } from '../lib/hideAmounts'
import { amountText, groupWhileTyping, parseAmount } from '../lib/money'

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

// Far longer than any real sum; working out a sum costs the square of its length, so a huge paste would freeze the tab.
const MAX_TYPED = 64

// Amount input: groups thousands while typing and reads the number by the
// language's separators ("1.250" in Vietnamese is one thousand two hundred fifty).
export function AmountField({ value, onChange, minorUnit, big = false, unit, ariaLabel, signed = false, sx, ...props }: Props) {
  const { t } = useTranslation()
  const { hidden } = useHideAmounts()
  const [focused, setFocused] = useState(false)
  const touch = useMediaQuery('(pointer: coarse)')
  const lang = currentLanguage()
  const typed = value.trim()
  const parsed = parseAmount(value, minorUnit, lang)
  const sum = /[+\-*/×÷]/.test(typed.replace(/^-/, ''))
  const unfinished = sum && /[+\-*/×÷]$/.test(typed)
  const bad = typed !== '' && !(signed && typed === '-') && parsed === null && !(focused && unfinished)
  const result = focused && sum && parsed !== null ? `= ${amountText(parsed, minorUnit, lang)}${unit ? ` ${unit}` : ''}` : undefined
  // The buttons keep the focus, so the cursor they type at is still the field's.
  const insert = (text: string) => {
    const field = document.activeElement
    const start = field instanceof HTMLInputElement ? field.selectionStart ?? value.length : value.length
    const end = field instanceof HTMLInputElement ? field.selectionEnd ?? start : start
    onChange(groupWhileTyping(value.slice(0, start) + text + value.slice(end), lang))
  }
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault()
  const keys = touch && focused && !props.disabled
  const helper = bad ? t('errors.amount') : result ?? props.helperText
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
      value={hidden && !focused && typed ? '••••' : value}
      onChange={(e) => onChange(groupWhileTyping(e.target.value, lang))}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e) }}
      onBlur={(e) => {
        setFocused(false)
        if (sum && parsed !== null) onChange(amountText(parsed, minorUnit, lang))
        props.onBlur?.(e)
      }}
      error={bad || props.error}
      helperText={keys ? (
        <Stack component="span" direction="row" sx={{ alignItems: 'center', gap: 1, mt: 0.5 }}>
          {['000', '+'].map((k) => (
            <Button key={k} size="small" variant="outlined" onMouseDown={keepFocus} onPointerDown={keepFocus} onClick={() => insert(k)}
              sx={{ minWidth: 44, fontVariantNumeric: 'tabular-nums' }}>
              {k}
            </Button>
          ))}
          {helper}
        </Stack>
      ) : helper}
      sx={[big && { '& .MuiOutlinedInput-root': { minHeight: 56, borderRadius: '10px' },
        '& .MuiOutlinedInput-input': { fontSize: 28, lineHeight: '36px', fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' } },
      ...(Array.isArray(sx) ? sx : [sx])]}
      slotProps={{
        htmlInput: { inputMode: minorUnit ? 'decimal' : 'numeric', autoComplete: 'off', 'aria-label': ariaLabel, maxLength: MAX_TYPED },
        input: end ? { endAdornment: end } : undefined,
      }}
    />
  )
}
