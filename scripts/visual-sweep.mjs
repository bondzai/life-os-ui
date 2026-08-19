/**
 * Visual sweep — the click-through, driven by the system Chrome.
 *
 * Loads every route the app registers, waits for it to settle, and records what a person would
 * otherwise have to notice by eye: console errors, uncaught exceptions, failed requests, the
 * React error boundary, and whether the page painted anything at all. A screenshot per route
 * lands in `shots/` so the layout can be looked at afterwards.
 *
 * ```bash
 * npm i --no-save playwright-core        # uses the system Chrome; downloads no browser
 * make dev-ui                            # :5173  (and the API on :3001)
 * node scripts/visual-sweep.mjs
 * ```
 *
 * Not part of `npm test`: it needs a browser, a running API and live upstreams. It is the check
 * for "does this actually work when a person opens it", which no unit test can answer — the two
 * bugs it found on its first run were a blank page with no way out and a setState during render,
 * both invisible to a green suite and a green route sweep.
 *
 * Env: BASE (default http://localhost:5173), API, PIN.
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.BASE ?? 'http://localhost:5173'
const API = process.env.API ?? 'http://localhost:3001/api'
const PIN = process.env.PIN ?? '1234'

const ROUTES = [
  '/', '/goals', '/tasks', '/calendar', '/notes', '/habits', '/review', '/inbox',
  '/dashboard', '/notifications', '/knowledge', '/deep-work', '/briefing', '/settings',
  '/wealth', '/wealth/holdings', '/wealth/defi', '/wealth/btc', '/wealth/bots',
  '/wealth/journal', '/wealth/settings',
]

// Noise that is not a defect: a dev-server websocket that closes on navigation, and the
// knowledge route's documented 404 when LYRA_KNOWLEDGE_PATH points nowhere.
const IGNORE = [
  /favicon/i, /\/@vite\//, /websocket/i, /ws:\/\//i,
  // Ollama is not running here. The browser calls it directly for the AI health check, and the
  // app is designed to fall back to algorithmic mode when it is absent — see nginx.conf's CSP
  // note. A connection refused on 11434 is the documented offline path, not a defect.
  /:11434/,
  // The knowledge repo is not mounted in this environment; the route 404s by design.
  /\/api\/knowledge/,
]

const res = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: PIN }),
})
if (!res.ok) throw new Error(`login failed: ${res.status}`)
const { token, user } = await res.json()

fs.mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

// Seed the session before any app code runs: the data-mode decides which repositories the
// modules bind at import time, so setting it after load would be too late.
await context.addInitScript(
  ([token, user]) => {
    localStorage.setItem('lyra:data-mode', 'api')
    localStorage.setItem('lyra:token', token)
    localStorage.setItem('lyra:auth', JSON.stringify({ state: { currentUser: user, isAuthenticated: true }, version: 0 }))
  },
  [token, user],
)

const rows = []
for (const route of ROUTES) {
  const page = await context.newPage()
  const problems = []
  page.on('console', (m) => {
    const text = m.text()
    if (m.type() !== 'error') return
    // "Failed to load resource: …" carries no URL, so it cannot be judged on its own. Every one
    // of them also arrives on `requestfailed`/`response`, which do have the URL and are filtered
    // there — keeping both would report the ignored ones twice under a name that hides them.
    if (/Failed to load resource/i.test(text)) return
    if (IGNORE.some((r) => r.test(text))) return
    problems.push(`console: ${text.slice(0, 160)}`)
  })
  page.on('pageerror', (e) => problems.push(`uncaught: ${String(e).slice(0, 160)}`))
  page.on('requestfailed', (r) => {
    if (!IGNORE.some((re) => re.test(r.url()))) problems.push(`request failed: ${r.url().slice(0, 120)}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400 && !IGNORE.some((re) => re.test(r.url()))) problems.push(`HTTP ${r.status()} ${r.url().replace(API, '').slice(0, 100)}`)
  })

  let painted = 0
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 45_000 })
    // Poll for content rather than sleeping a fixed time: the wealth pages fan out across six
    // chains behind a cold cache, and a fixed wait either flakes or makes every route slow.
    const budget = route.startsWith('/wealth') ? 40_000 : 12_000
    const started = Date.now()
    while (Date.now() - started < budget) {
      painted = (await page.locator('main, [role="main"], body').first().innerText().catch(() => '')).trim().length
      const settled = await page.locator('.animate-pulse, [data-slot="skeleton"]').count().catch(() => 0)
      if (painted > 400 && settled === 0) break
      await page.waitForTimeout(750)
    }
    await page.screenshot({ path: `shots/${route.replace(/\//g, '_') || '_root'}.jpg`, type: 'jpeg', quality: 60 })
  } catch (e) {
    problems.push(`navigation: ${String(e).slice(0, 160)}`)
  }

  const boundary = await page.getByText(/Something went wrong|Could not load|Session expired/i).count().catch(() => 0)
  rows.push({ route, chars: painted, boundary, problems })
  await page.close()
}

await browser.close()

let bad = 0
for (const r of rows) {
  const ok = r.problems.length === 0 && r.boundary === 0 && r.chars > 40
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${r.route.padEnd(20)} ${String(r.chars).padStart(6)} chars${r.boundary ? '  [error state]' : ''}`)
  for (const p of r.problems.slice(0, 4)) console.log(`        ${p}`)
}
console.log(`\n${rows.length - bad}/${rows.length} routes clean`)
