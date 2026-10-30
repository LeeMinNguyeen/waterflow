import { useTheme } from '@mui/material/styles'

// Spending and income differ in lightness as well as hue (dark red and light green in light mode, the other way
// round in dark mode), so the bars can be told apart without seeing red from green.
export function useChartColors() {
  const { palette } = useTheme()
  return { spent: palette.chart.spending, income: palette.chart.income, grid: palette.divider }
}
