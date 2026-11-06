import Typography, { type TypographyProps } from '@mui/material/Typography'
import { currentLanguage } from '../i18n'
import { useFormatMoney } from '../lib/hideAmounts'
import { amountTone, type AmountKind } from '../lib/money'
import { useCurrencies } from '../lib/queries'

// quiet: a plain amount takes the colour of the text around it, for an amount in a caption.
type Props = Omit<TypographyProps, 'children'> & { amount: number; currency: string; kind?: AmountKind; sign?: boolean; quiet?: boolean }

const toneColor = { negative: 'error.main', positive: 'success.main', neutral: 'text.primary' } as const

export function Money({ amount, currency, kind = 'flow', sign = false, quiet = false, sx, ...props }: Props) {
  const currencies = useCurrencies()
  const formatMoney = useFormatMoney()
  if (!currencies.data) return null
  const shown = kind === 'transfer' ? Math.abs(amount) : amount
  const tone = amountTone(amount, kind)
  const text = formatMoney(shown, currency, currencies.data.get(currency)?.minor_unit ?? 0, currentLanguage(), { sign: sign && kind !== 'transfer' })
    .replace('-', '−')
  return (
    <Typography component="span" variant="inherit" {...props}
      sx={[{ color: quiet && tone === 'neutral' ? 'inherit' : toneColor[tone], fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, ...(Array.isArray(sx) ? sx : [sx])]}>
      {text}
    </Typography>
  )
}
