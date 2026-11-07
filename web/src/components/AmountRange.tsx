import Stack from '@mui/material/Stack'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { amountText, parseAmount } from '../lib/money'
import { AmountField } from './AmountField'

type Range = { min?: string; max?: string }

// From and to as typed, sent a moment after typing stops; each is minor units, or '' when empty.
export function AmountRange({ min, max, minorUnit, onChange }: Range & { minorUnit: number; onChange: (range: Range) => void }) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const shown = (v?: string) => (v ? amountText(Number(v), minorUnit, lang) : '')
  const [from, setFrom] = useState(shown(min))
  const [to, setTo] = useState(shown(max))

  useEffect(() => {
    const read = (text: string) => {
      if (!text.trim()) return ''
      const minor = parseAmount(text, minorUnit, lang)
      return minor !== null && minor >= 0 ? String(minor) : null
    }
    const id = setTimeout(() => {
      const range = { min: read(from), max: read(to) }
      if (range.min !== null && range.max !== null) onChange(range as Range)
    }, 350)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  return (
    <Stack spacing={2}>
      <AmountField label={t('filters.from')} value={from} onChange={setFrom} minorUnit={minorUnit} />
      <AmountField label={t('filters.to')} value={to} onChange={setTo} minorUnit={minorUnit} />
    </Stack>
  )
}
