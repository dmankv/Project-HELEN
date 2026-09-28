import fs from 'node:fs'

const authDataFile = process.env.AUTH_DATA_FILE

if (!authDataFile) {
  console.log(JSON.stringify({ ok: false, code: 'EINVAL', message: 'AUTH_DATA_FILE is required' }))
  process.exit(0)
}

const originalLinkSync = fs.linkSync
const originalRenameSync = fs.renameSync
const originalWriteFileSync = fs.writeFileSync

if (process.env.AUTH_TEST_LINK_UNSUPPORTED === '1') {
  fs.linkSync = function mockedLinkSync() {
    const err = new Error('hard links unsupported')
    ;(err).code = 'ENOTSUP'
    throw err
  }
}

const renameDelayMs = Number(process.env.AUTH_TEST_RENAME_DELAY_MS ?? 0)
if (renameDelayMs > 0) {
  fs.renameSync = function delayedRenameSync(...args) {
    const waitState = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitState, 0, 0, renameDelayMs)
    return originalRenameSync.apply(this, args)
  }
}

const tmpWriteErrorCode = process.env.AUTH_TEST_TMP_WRITE_ERROR_CODE
if (tmpWriteErrorCode) {
  fs.writeFileSync = function failTmpWrite(file, data, options) {
    const filePath = String(file)
    if (filePath.startsWith(`${authDataFile}.`) && filePath.endsWith('.tmp')) {
      const err = new Error(`injected ${tmpWriteErrorCode}`)
      ;(err).code = tmpWriteErrorCode
      throw err
    }
    return originalWriteFileSync.call(this, file, data, options)
  }
}

process.env.PORT = '0'
process.env.OPENAI_API_KEY = ''
process.env.AUTH_REQUIRE_HTTPS = 'false'
process.env.AUTH_SECURE_COOKIES = 'false'

try {
  await import('../../server/index.ts')
  const parsed = JSON.parse(fs.readFileSync(authDataFile, 'utf8'))
  const valid =
    parsed && Array.isArray(parsed.users) && Array.isArray(parsed.sessions) && Array.isArray(parsed.tokens)
  console.log(JSON.stringify({ ok: valid }))
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      code: error?.code ?? null,
      name: error?.name ?? null,
      message: error?.message ?? null,
    }),
  )
}
