import { mkdir, writeFile } from 'node:fs/promises'

const url = 'https://raw.githubusercontent.com/OneSmarterInc/onesmarterweb/main/src/Images/ONESMARTER.png'
const fallback = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="80" viewBox="0 0 360 80"><rect width="360" height="80" fill="none"/><circle cx="40" cy="40" r="30" fill="#e31b23"/><path d="M21 18c22 7 35 21 40 43-12 11-29 13-42 5 17-14 22-30 2-48Z" fill="#fff" opacity=".9"/><text x="84" y="50" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="800" fill="#e31b23">ONESMARTER, INC.</text></svg>`
await mkdir('public', { recursive: true })
try {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Logo fetch failed: ${response.status}`)
  await writeFile('public/onesmarter-logo.png', Buffer.from(await response.arrayBuffer()))
  console.log('OneSmarter logo bundled')
} catch (error) {
  console.warn(String(error?.message || error))
  await writeFile('public/onesmarter-logo.svg', fallback)
  console.log('OneSmarter fallback logo bundled')
}
