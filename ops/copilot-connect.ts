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

const token = await readStdin()
if (!token) die('Empty stdin — nothing to save.')
// Firebase refresh tokens are long opaque strings; a stray "copied" line or an
// ID token (three dot-separated segments) is a paste mistake worth catching.
if (token.length < 40) die(`That is ${token.length} chars — too short for a refresh token.`)
if (token.split('.').length === 3) die('That looks like an ID token, not a refresh token.')
if (/\s/.test(token)) die('The token has whitespace in it — check what was copied.')

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
