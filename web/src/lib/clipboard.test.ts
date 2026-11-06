import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copying on a server reached over plain http (review #166)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('falls back to the selection when the Clipboard API is missing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const exec = vi.fn(() => true)
    document.execCommand = exec
    expect(await copyText('X7K2-9QPM')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('uses the Clipboard API where there is one', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    expect(await copyText('abc')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
  })

  it('selects the text beside the focused button, and gives the focus back', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const box = document.body.appendChild(document.createElement('div'))
    const button = box.appendChild(document.createElement('button'))
    button.focus()
    let selected = ''
    let where: Element | null = null
    document.execCommand = vi.fn(() => {
      const area = document.activeElement as HTMLTextAreaElement
      selected = area.value.slice(area.selectionStart, area.selectionEnd)
      where = area.parentElement
      return true
    })
    expect(await copyText('codes')).toBe(true)
    expect([selected, where]).toEqual(['codes', box])
    expect(document.activeElement).toBe(button)
    box.remove()
  })
})
