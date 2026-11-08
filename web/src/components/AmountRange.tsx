import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { amountText, parseAmount } from '../lib/money'
import { AmountField } from './AmountField'

type Range = { min?: string; max?: string; currency?: string }
type Props = Range & {
  codes: string[]                              // the currencies to offer; none when an account fixes it
  reference: (picked: string[]) => { code: string; minorUnit: number }
  onChange: (range: Range) => void
}

// From and to as typed, and the currencies picked, sent a moment after typing stops. Amounts are minor units of the
// reference currency ('' when empty); currency is a comma-separated list ('' for any).
export function AmountRange({ min, max, currency, codes, reference, onChange }: Props) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const [picked, setPicked] = useState(currency ? currency.split(',') : [])
  const { minorUnit } = reference(picked)
  const shown = (v?: string) => (v ? amountText(Number(v), minorUnit, lang) : '')
  const [from, setFrom] = useState(shown(min))
  const [to, setTo] = useState(shown(max))
  const pending = useRef<Range | null>(null)
  const send = useRef(onChange)
  useEffect(() => { send.current = onChange })

  useEffect(() => {
    const read = (text: string) => {
      if (!text.trim()) return ''
      const minor = parseAmount(text, minorUnit, lang)
      return minor !== null && minor >= 0 ? String(minor) : null
    }
    // An amount that doesn't read in the currency now meant is left out, so the currencies picked still apply.
    const range = { min: read(from) ?? '', max: read(to) ?? '', currency: picked.join(',') }
    pending.current = range
    const id = setTimeout(() => {
      pending.current = null
      send.current(range)
    }, 350)
    return () => clearTimeout(id)
  }, [from, to, picked, minorUnit, lang])

  // Closed before the pause ended: what was typed still applies, unless the page itself was left.
  useEffect(() => {
    const page = window.location.pathname
    return () => { if (pending.current && window.location.pathname === page) send.current(pending.current) }
  }, [])

  return (
    <Stack spacing={2}>
      <AmountField label={t('filters.amountFrom')} value={from} onChange={setFrom} minorUnit={minorUnit} />
      <AmountField label={t('filters.amountTo')} value={to} onChange={setTo} minorUnit={minorUnit} />
      {codes.length > 1 && (
        <TextField select label={t('filters.currency')} value={picked}
          onChange={(e) => setPicked(codes.filter((c) => (e.target.value as unknown as string[]).includes(c)))}
          slotProps={{ select: { multiple: true, renderValue: (v) => (v as string[]).join(', ') } }}>
          {codes.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
        </TextField>
      )}
    </Stack>
  )
}
