import { Hono } from 'hono'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'fs'
import { join, relative, resolve, dirname } from 'path'
import { execSync, execFileSync } from 'child_process'

type Env = { Variables: { userId: string; userRole: string } }

export const knowledgeRoutes = new Hono<Env>()

const KNOWLEDGE_PATH = process.env.LYRA_KNOWLEDGE_PATH || join(process.cwd(), '..', 'lyra-knowledge')

interface KnowledgeFile {
  path: string
  name: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

function parseValue(raw: string): unknown {
  const val = raw.trim()
  if (val.startsWith('[') && val.endsWith(']')) {
    // Prefer JSON so commas inside quoted items survive the round-trip; an
    // empty list parses to [] rather than ['']. Fall back to the legacy
    // unquoted `[a, b]` form for files written before this format.
    try {
      const parsed = JSON.parse(val)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // not JSON — handled below
    }
    const inner = val.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((s) => s.trim().replace(/['"]/g, ''))
  }
  return val
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, unknown> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/)
    if (kv) {
      frontmatter[kv[1]] = parseValue(kv[2])
    }
  }
  return { frontmatter, body: match[2].trim() }
}

function serializeFrontmatter(fm: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    // JSON-encode arrays so commas/quotes inside items round-trip cleanly.
    lines.push(Array.isArray(v) ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`)
  }
  lines.push('---', '', body, '')
  return lines.join('\n')
}

function readKnowledgeFile(filePath: string): KnowledgeFile {
  const content = readFileSync(filePath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter(content)
  const relPath = relative(KNOWLEDGE_PATH, filePath)
  const updated = frontmatter.updated
  return {
    path: relPath,
    name: relPath.replace(/\.md$/, ''),
    frontmatter,
    body,
    // Fall back to the file's mtime only when the frontmatter has no date,
    // avoiding a statSync syscall per file when listing/searching.
    updatedAt: typeof updated === 'string' ? updated : statSync(filePath).mtime.toISOString().split('T')[0],
  }
}

function collectFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'templates') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(full))
    } else if (entry.name.endsWith('.md')) {
      files.push(full)
    }
  }
  return files
}

// Resolve a client-supplied relative path against KNOWLEDGE_PATH, rejecting any
// path that escapes the knowledge directory (e.g. `../../etc/passwd`).
const KNOWLEDGE_ROOT = resolve(KNOWLEDGE_PATH)
function resolveWithin(relPath: string): string | null {
  const full = resolve(KNOWLEDGE_PATH, relPath)
  if (full !== KNOWLEDGE_ROOT && !full.startsWith(KNOWLEDGE_ROOT + '/')) return null
  return full
}

function gitCommit(filePath: string, message: string) {
  try {
    // execFileSync with an argument array — no shell, so user-controlled paths
    // and messages cannot inject commands.
    execFileSync('git', ['add', filePath], { cwd: KNOWLEDGE_PATH, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', message], { cwd: KNOWLEDGE_PATH, stdio: 'pipe' })
  } catch {
    // no changes to commit
  }
}

// GET / — list all knowledge files
knowledgeRoutes.get('/', (c) => {
  if (!existsSync(KNOWLEDGE_PATH)) {
    return c.json({ error: 'Knowledge path not found', path: KNOWLEDGE_PATH }, 404)
  }
  const files = collectFiles(KNOWLEDGE_PATH).map(readKnowledgeFile)
  return c.json(files)
})

// GET /file/:path — read single file
knowledgeRoutes.get('/file/:path{.+}', (c) => {
  const full = resolveWithin(c.req.param('path'))
  if (!full || !existsSync(full)) return c.json({ error: 'Not found' }, 404)
  return c.json(readKnowledgeFile(full))
})

// PUT /file/:path — update file content + git commit
knowledgeRoutes.put('/file/:path{.+}', async (c) => {
  const filePath = c.req.param('path')
  const full = resolveWithin(filePath)
  if (!full || !existsSync(full)) return c.json({ error: 'Not found' }, 404)

  const { frontmatter, body } = await c.req.json<{ frontmatter: Record<string, unknown>; body: string }>()
  frontmatter.updated = new Date().toISOString().split('T')[0]
  writeFileSync(full, serializeFrontmatter(frontmatter, body))
  gitCommit(full, `update: ${filePath}`)

  return c.json(readKnowledgeFile(full))
})

// POST /log — create new log entry + git commit
knowledgeRoutes.post('/log', async (c) => {
  const { title, body } = await c.req.json<{ title: string; body: string }>()
  if (!title?.trim()) return c.json({ error: 'Title required' }, 400)
  const date = new Date().toISOString().split('T')[0]
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'entry'
  const fileName = `${date}-${slug}.md`
  const full = join(KNOWLEDGE_PATH, 'log', fileName)

  const content = serializeFrontmatter(
    { type: 'log', tags: [], date, updated: date },
    `# ${title}\n\n${body}`,
  )
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  gitCommit(full, `log: ${title}`)

  return c.json(readKnowledgeFile(full), 201)
})

// GET /search?q= — search across all files
knowledgeRoutes.get('/search', (c) => {
  const query = c.req.query('q')?.toLowerCase()
  if (!query) return c.json([])

  const files = collectFiles(KNOWLEDGE_PATH).map(readKnowledgeFile)
  const results = files.filter(
    (f) =>
      f.body.toLowerCase().includes(query) ||
      f.name.toLowerCase().includes(query) ||
      JSON.stringify(f.frontmatter).toLowerCase().includes(query),
  )
  return c.json(results)
})

// GET /history — recent git commits
knowledgeRoutes.get('/history', (c) => {
  try {
    const log = execSync('git log --oneline -20 --format="%h|%s|%ai"', {
      cwd: KNOWLEDGE_PATH,
      encoding: 'utf-8',
    })
    const commits = log.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, message, date] = line.split('|')
      return { hash, message, date }
    })
    return c.json(commits)
  } catch {
    return c.json([])
  }
})
