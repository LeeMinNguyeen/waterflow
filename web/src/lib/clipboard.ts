// The Clipboard API exists only on https (or localhost); a server on a home network is often plain http, where a
// hidden text area and the older copy command still work. False when neither did.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // refused (no focus, no permission): try the other way
    }
  }
  const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true })
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
