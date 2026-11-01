import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
import manifestText from '../public/manifest.webmanifest?raw'

type Icon = { src: string; sizes: string; type: string; purpose?: string }
const files = Object.keys(import.meta.glob('../public/**/*.png'))
const exists = (src: string) => files.includes(`../public${src}`)

describe('adding Waterflow to a home screen (waterflow#124)', () => {
  const manifest = JSON.parse(manifestText) as { icons: Icon[] } & Record<string, unknown>

  it('opens full screen at the root of whatever address it was added from, named Waterflow', () => {
    expect(manifest).toMatchObject({ name: 'Waterflow', short_name: 'Waterflow', start_url: '/', scope: '/', display: 'standalone' })
  })

  it('has 192 and 512 px icons and a maskable one, and every icon exists', () => {
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
    for (const icon of manifest.icons) expect(exists(icon.src), icon.src).toBe(true)
  })

  it('links the manifest, the touch icon and a theme colour for light and dark from index.html', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    const touch = /<link rel="apple-touch-icon" href="([^"]+)" \/>/.exec(indexHtml)?.[1]
    expect(touch && exists(touch)).toBe(true)
    expect(indexHtml).toMatch(/<meta name="theme-color" content="#[0-9A-F]{6}" media="\(prefers-color-scheme: light\)" \/>/)
    expect(indexHtml).toMatch(/<meta name="theme-color" content="#[0-9A-F]{6}" media="\(prefers-color-scheme: dark\)" \/>/)
  })
})
