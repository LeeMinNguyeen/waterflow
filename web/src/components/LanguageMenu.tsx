import Button from '@mui/material/Button'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage, languages, setSignInLanguage } from '../i18n'

// This browser's sign-in language: the current one in its own name, opening the list of all, each in its own name.
export function LanguageMenu() {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const current = currentLanguage()
  return (
    <>
      <Button lang={current} aria-haspopup="menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ color: 'text.primary', fontWeight: 500 }}>
        {`${t(`language.${current}`)} ▾`}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        {languages.map((l) => (
          <MenuItem key={l} lang={l} selected={l === current} onClick={() => { setAnchor(null); setSignInLanguage(l) }}>
            {t(`language.${l}`)}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
