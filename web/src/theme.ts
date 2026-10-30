import { createTheme, type Theme } from '@mui/material/styles'
import type {} from '@mui/x-date-pickers/themeAugmentation'
import type { CSSProperties } from 'react'

declare module '@mui/material/styles' {
  interface TypeBackground {
    sidebar: string // one shade darker than the page, so the sidebar stands apart from the content
    subtle: string
  }
  interface Palette {
    lineStrong: string
    accentSoft: string
    chart: { spending: string; income: string }
  }
  interface PaletteOptions {
    lineStrong?: string
    accentSoft?: string
    chart?: { spending: string; income: string }
  }
  interface TypographyVariants {
    display: CSSProperties
  }
  interface TypographyVariantsOptions {
    display?: CSSProperties
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    display: true
  }
}

const light = {
  bg: '#FFFFFF', subtle: '#F5F5F3', line: '#ECECE9', lineStrong: '#D9D9D5', ink: '#18181B', ink2: '#5E5E66', ink3: '#8F8F97',
  accent: '#2E6BE6', accentInk: '#FFFFFF', accentSoft: '#EBF1FD', positive: '#18803E', negative: '#C9372C',
  spending: '#D9534A', income: '#8ACB9F', sidebar: '#F5F5F3',
}
const dark: typeof light = {
  bg: '#121214', subtle: '#1C1C1F', line: '#25252A', lineStrong: '#37373D', ink: '#EDEDEF', ink2: '#A3A3AB', ink3: '#71717A',
  accent: '#7AA3FF', accentInk: '#0B1530', accentSoft: '#1B2945', positive: '#5CC685', negative: '#F27F74',
  spending: '#EE8076', income: '#2C7A4D', sidebar: '#0C0C0E',
}

const palette = (c: typeof light) => ({
  background: { default: c.bg, paper: c.bg, sidebar: c.sidebar, subtle: c.subtle },
  text: { primary: c.ink, secondary: c.ink2, disabled: c.ink3 },
  divider: c.line,
  lineStrong: c.lineStrong,
  accentSoft: c.accentSoft,
  primary: { main: c.accent, contrastText: c.accentInk },
  success: { main: c.positive },
  error: { main: c.negative },
  action: { hover: c.subtle, selected: c.subtle },
  chart: { spending: c.spending, income: c.income },
})

const tabular = { fontVariantNumeric: 'tabular-nums' } as const

// Follows the device's light or dark setting.
export const theme = createTheme({
  colorSchemes: {
    light: { palette: palette(light) },
    dark: { palette: palette(dark) },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 14,
    display: { fontSize: 32, lineHeight: '40px', fontWeight: 600, letterSpacing: '-0.02em', ...tabular },
    h1: { fontSize: 24, lineHeight: '32px', fontWeight: 600, letterSpacing: '-0.012em' },
    h2: { fontSize: 15, lineHeight: '22px', fontWeight: 600 },
    h3: { fontSize: 18, lineHeight: '24px', fontWeight: 600 },
    h4: { fontSize: 24, lineHeight: '32px', fontWeight: 600, letterSpacing: '-0.012em' },
    h5: { fontSize: 24, lineHeight: '32px', fontWeight: 600, letterSpacing: '-0.012em' },
    h6: { fontSize: 18, lineHeight: '24px', fontWeight: 600 },
    subtitle1: { fontSize: 15, lineHeight: '22px', fontWeight: 600 },
    subtitle2: { fontSize: 13, lineHeight: '18px', fontWeight: 600 },
    body1: { fontSize: 14, lineHeight: '20px' },
    body2: { fontSize: 13, lineHeight: '18px' },
    caption: { fontSize: 12, lineHeight: '16px' },
    button: { fontSize: 14, fontWeight: 500, textTransform: 'none' },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: { body: { WebkitFontSmoothing: 'antialiased' } },
    },
    MuiTypography: {
      defaultProps: { variantMapping: { display: 'p' } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { minHeight: 36, borderRadius: 8, paddingInline: 14 },
        sizeSmall: { minHeight: 30, paddingInline: 10, fontSize: 13 },
        sizeLarge: { minHeight: 40 },
      },
      variants: [
        { props: { variant: 'outlined', color: 'primary' }, style: ({ theme }: { theme: Theme }) => ({ borderColor: theme.palette.lineStrong, color: theme.palette.text.primary }) },
        { props: { variant: 'text', color: 'primary' }, style: ({ theme }: { theme: Theme }) => ({ color: theme.palette.text.secondary }) },
      ],
    },
    MuiIconButton: {
      styleOverrides: { root: ({ theme }: { theme: Theme }) => ({ color: theme.palette.text.disabled, borderRadius: 8 }) },
    },
    MuiTextField: { defaultProps: { fullWidth: true } },
    MuiFormControl: {
      styleOverrides: { root: { gap: 6 } },
    },
    MuiInputLabel: {
      defaultProps: { shrink: true },
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          position: 'relative', transform: 'none', fontSize: 13, lineHeight: '18px', fontWeight: 500,
          color: theme.palette.text.secondary, whiteSpace: 'normal', maxWidth: '100%',
          '&.Mui-focused': { color: theme.palette.text.secondary },
          '&.Mui-error': { color: theme.palette.text.secondary },
        }),
        asterisk: { display: 'none' },
      },
    },
    MuiOutlinedInput: {
      defaultProps: { notched: false },
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          borderRadius: 8,
          backgroundColor: theme.palette.background.default,
          '& .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.lineStrong, top: 0 },
          '& .MuiOutlinedInput-notchedOutline legend': { display: 'none' },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.text.disabled },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main, borderWidth: 1.5 },
          '&.Mui-focused': { boxShadow: `0 0 0 3px ${theme.palette.accentSoft}` },
          '&.Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.error.main, borderWidth: 1.5 },
        }),
        input: { paddingBlock: 10, paddingInline: 12 },
      },
      variants: [
        { props: { size: 'small' }, style: { '& .MuiOutlinedInput-input': { paddingBlock: 7 } } },
        { props: { multiline: true }, style: { padding: 0 } },
      ],
    },
    MuiAutocomplete: {
      styleOverrides: {
        inputRoot: { paddingBlock: '0 !important', paddingLeft: '12px !important' },
        input: { paddingBlock: '10px !important', paddingInline: '0 !important' },
      },
    },
    MuiPickersOutlinedInput: {
      defaultProps: { notched: false },
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          borderRadius: 8,
          backgroundColor: theme.palette.background.default,
          '& .MuiPickersOutlinedInput-notchedOutline': { borderColor: theme.palette.lineStrong, top: 0 },
          '& .MuiPickersOutlinedInput-notchedOutline legend': { display: 'none' },
          '&:hover .MuiPickersOutlinedInput-notchedOutline': { borderColor: theme.palette.text.disabled },
          '&.Mui-focused .MuiPickersOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main, borderWidth: 1.5 },
          '&.Mui-focused': { boxShadow: `0 0 0 3px ${theme.palette.accentSoft}` },
          '&.Mui-error .MuiPickersOutlinedInput-notchedOutline': { borderColor: theme.palette.error.main, borderWidth: 1.5 },
          '&&': { paddingLeft: 12 },
        }),
        sectionsContainer: ({ ownerState }: { ownerState: { inputSize?: string } }) => ({ paddingBlock: ownerState.inputSize === 'small' ? 7 : 10 }),
      },
    },
    MuiFormHelperText: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({ marginInline: 0, marginTop: 0, fontSize: 12, lineHeight: '16px', color: theme.palette.text.disabled }),
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        outlined: { border: 0, backgroundColor: 'transparent' },
      },
    },
    MuiMenu: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        paper: ({ theme }: { theme: Theme }) => ({ border: `1px solid ${theme.palette.divider}`, boxShadow: '0 12px 32px rgba(24,24,27,.14)', borderRadius: 10 }),
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: ({ theme }: { theme: Theme }) => ({ border: `1px solid ${theme.palette.divider}`, boxShadow: '0 12px 32px rgba(24,24,27,.14)', borderRadius: 10 }),
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 14, boxShadow: '0 12px 32px rgba(24,24,27,.14), 0 0 0 1px rgba(24,24,27,.06)' },
        paperFullScreen: { borderRadius: 0 },
      },
    },
    MuiDialogTitle: {
      styleOverrides: { root: { fontSize: 18, lineHeight: '24px', fontWeight: 600, padding: '20px 24px 8px' } },
    },
    MuiDialogContent: {
      styleOverrides: { root: { paddingInline: 24 } },
    },
    MuiChip: {
      styleOverrides: { root: { borderRadius: 999 } },
    },
    MuiDivider: {
      styleOverrides: { root: ({ theme }: { theme: Theme }) => ({ borderColor: theme.palette.divider }) },
    },
    MuiTableCell: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({ borderColor: theme.palette.divider }),
        head: ({ theme }: { theme: Theme }) => ({ fontSize: 12, color: theme.palette.text.disabled, fontWeight: 400 }),
      },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: 8 } },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          border: 0, borderRadius: 7, color: theme.palette.text.secondary, fontWeight: 500, minHeight: 30, paddingBlock: 4,
          '&.Mui-selected, &.Mui-selected:hover': {
            backgroundColor: theme.palette.background.default, color: theme.palette.text.primary,
            boxShadow: `0 1px 2px rgba(0,0,0,.06), 0 0 0 1px ${theme.palette.lineStrong}`,
          },
        }),
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({ backgroundColor: theme.palette.background.subtle, borderRadius: 9, padding: 3, gap: 2 }),
        grouped: { borderRadius: '7px !important', border: '0 !important', margin: 0 },
      },
    },
    MuiSwitch: {
      defaultProps: { color: 'primary' },
    },
  },
})
