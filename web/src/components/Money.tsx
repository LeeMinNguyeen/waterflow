import Typography, { type TypographyProps } from '@mui/material/Typography'
import { currentLanguage } from '../i18n'
import { amountTone, formatMoney, type AmountKind } from '../lib/money'
import { useCurrencies } from '../lib/queries'

type Props = Omit<TypographyProps, 'children'> & { amount: number; currency: string; kind?: AmountKind; sign?: boolean }

const toneColor = { negative: 'error.main', positive: 'success.main', neutral: 'text.primary' } as const

export function Money({ amount, currency, kind = 'flow', sign = false, sx, ...props }: Props) {
  const currencies = useCurrencies()
  if (!currencies.data) return null
  const shown = kind === 'transfer' ? Math.abs(amount) : amount
  const text = formatMoney(shown, currency, currencies.data.get(currency)?.minor_unit ?? 0, currentLanguage(), { sign: sign && kind !== 'transfer' })
  return (
    <Typography component="span" variant="inherit" {...props}
      sx={[{ color: toneColor[amountTone(amount, kind)], fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, ...(Array.isArray(sx) ? sx : [sx])]}>
      {text}
    </Typography>
  )
}
