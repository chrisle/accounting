/**
 * Connect Copilot from the terminal instead of the Sources form.
 *
 *   pbpaste | npm run copilot:connect
 *   pbpaste | npm run copilot:connect -- <firebase-api-key>
 *
 * The token arrives on stdin so it never reaches argv (where `ps` would show
 * it) or shell history. It is sealed with COSTS_ENCRYPTION_KEY the same way the
 * UI seals it, then verified against Firebase and used to run one sync.
 */
import { readFileSync } from 'node:fs'

// Runs outside Next, which is what normally loads .env.local.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

/** Paste mistakes are the common case here, so they get a line, not a stack. */
function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    die('No stdin. Pipe the token in: pbpaste | npm run copilot:connect')
  }
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

let token = await readStdin()
if (!token) die('Empty stdin — nothing to save.')
// Firebase refresh tokens are long opaque strings; a stray "copied" line or an
// ID token (three dot-separated segments) is a paste mistake worth catching.
if (token.length < 40) die(`That is ${token.length} chars — too short for a refresh token.`)
if (token.split('.').length === 3) die('That looks like an ID token, not a refresh token.')
// A clipboard that picked up console output or a terminal selection has the
// token buried in other text. Recovering it beats making the user re-copy, and
// a wrong guess is harmless: Firebase verifies it before anything is stored.
if (/\s/.test(token)) {
  const candidates = [...new Set(token.split(/\s+/).filter((w) => /^[A-Za-z0-9_-]{40,}$/.test(w)))]
  if (candidates.length !== 1) {
    die(
      candidates.length === 0
        ? 'The input has whitespace and nothing in it looks like a refresh token — check what was copied.'
        : `Found ${candidates.length} token-shaped strings in the input; pipe in just the token.`,
    )
  }
  console.log(`Input had surrounding text — using the one token-shaped string in it (${candidates[0].length} chars).`)
  token = candidates[0]
}

// saveRefreshToken proves the token against Firebase before it stores it, so a
// bad paste fails here without leaving the source looking connected.
const { saveRefreshToken } = await import('../src/lib/sources/copilot/auth')
try {
  await saveRefreshToken(token, process.argv[2])
} catch (e) {
  die(e instanceof Error ? e.message : String(e))
}
console.log(`Verified against Firebase and sealed a ${token.length}-char refresh token.`)

const { runJob } = await import('../src/lib/jobs/tasks')
await runJob({ id: 'cli', kind: 'sync:copilot', payload: {} } as never, (m: string) => console.log('   ', m))

const { getRaw } = await import('../src/db')
const raw = getRaw()
const { n, min, max } = raw
  .prepare("select count(*) n, min(date) min, max(date) max from transactions where id not like 'sub-%' and id not like 'amzn-%' and id not like 'gcp-%' and id not like 'misc-%'")
  .get() as { n: number; min: string; max: string }
console.log(`\n${n} real transactions in the ledger${n ? ` (${min} .. ${max})` : ''}.`)
