import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const port = 3311
const baseUrl = `http://127.0.0.1:${port}`
const token = 'test-token'
const origin = 'http://localhost:3000'

let passed = 0
let failed = 0

function check(label, condition) {
  if (condition) {
    console.log('  ✅ ' + label)
    passed++
  } else {
    console.error('  ❌ FAIL: ' + label)
    failed++
  }
}

async function request(pathname, options = {}) {
  const res = await fetch(baseUrl + pathname, options)
  const text = await res.text()
  return { res, text }
}

async function main() {
  console.log('\n── server api checks ──')
  const server = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HELEN_API_TOKEN: token,
      HELEN_RATE_LIMIT: '1',
      HELEN_RATE_LIMIT_WINDOW_MS: '3600000',
      HELEN_TRUST_PROXY: '1',
      HELEN_ALLOWED_ORIGINS: origin,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  let ready = false
  const waitReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 20000)
    const onExit = code => {
      if (!ready) {
        clearTimeout(timeout)
        reject(new Error('Server exited early with code ' + code))
      }
    }
    server.stdout.on('data', chunk => {
      const line = String(chunk)
      if (line.includes('Listening on')) {
        ready = true
        clearTimeout(timeout)
        server.off('exit', onExit)
        resolve(undefined)
      }
    })
    server.stderr.on('data', chunk => {
      process.stderr.write(String(chunk))
    })
    server.on('exit', onExit)
  })

  try {
    await waitReady

    const health = await request('/health')
    check('GET /health returns 200', health.res.status === 200)

    const preflightAllowed = await request('/api/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'X-Forwarded-For': '10.0.0.1',
      },
    })
    check('Allowed preflight returns 204', preflightAllowed.res.status === 204)
    check(
      'Allowed preflight includes ACAO header',
      preflightAllowed.res.headers.get('access-control-allow-origin') === origin,
    )

    const preflightDenied = await request('/api/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'X-Forwarded-For': '10.0.0.2',
      },
    })
    check('Disallowed preflight returns 403', preflightDenied.res.status === 403)

    const missingOrigin = await request('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HELEN-API-TOKEN': token,
        'X-Forwarded-For': '10.0.0.3',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    check('POST /api/chat without Origin is rejected', missingOrigin.res.status === 403)

    const missingToken = await request('/api/chat', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.0.0.4',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    check('POST /api/chat without token is rejected', missingToken.res.status === 401)

    const invalidBody = await request('/api/chat', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-HELEN-API-TOKEN': token,
        'X-Forwarded-For': '10.0.0.5',
      },
      body: JSON.stringify({ nope: true }),
    })
    check('POST /api/chat invalid payload returns 400', invalidBody.res.status === 400)

    const oversized = await request('/api/chat', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-HELEN-API-TOKEN': token,
        'X-Forwarded-For': '10.0.0.6',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'x'.repeat(70_000) }],
      }),
    })
    check('POST /api/chat oversized payload returns 400', oversized.res.status === 400)

    const firstAuthorized = await request('/api/chat', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-HELEN-API-TOKEN': token,
        'X-Forwarded-For': '10.0.0.7',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    })
    check('First authorized request reaches provider layer (expected 502)', firstAuthorized.res.status === 502)

    const secondAuthorized = await request('/api/chat', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-HELEN-API-TOKEN': token,
        'X-Forwarded-For': '10.0.0.7',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello again' }],
      }),
    })
    check('Second request within window is rate limited', secondAuthorized.res.status === 429)
  } finally {
    try {
      if (server.pid) process.kill(-server.pid, 'SIGKILL')
    } catch {
      // ignore cleanup errors
    }
  }

  console.log(`\nserver api checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
