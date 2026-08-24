import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteConfigPath = path.join(repoRoot, 'vite.config.ts')
const distIndexPath = path.join(repoRoot, 'dist', 'index.html')
const distFaviconPath = path.join(repoRoot, 'dist', 'favicon.svg')

function fail(message) {
  console.error(message)
  process.exit(1)
}

const viteConfig = fs.readFileSync(viteConfigPath, 'utf8')
const baseMatch = viteConfig.match(/^\s*base:\s*['"]([^'"]+)['"]/m)

if (!baseMatch) {
  fail('Could not determine Vite base path from vite.config.ts')
}

const rawBasePath = baseMatch[1]
const protectedPagesBasePath = '/Project-HELEN/'
if (rawBasePath !== protectedPagesBasePath) {
  fail(`Vite base path must remain ${protectedPagesBasePath}, received ${rawBasePath}`)
}
const normalizedBasePath = rawBasePath.endsWith('/') ? rawBasePath : `${rawBasePath}/`
const assetPrefix = `${normalizedBasePath}assets/`

if (!fs.existsSync(distIndexPath)) {
  fail('dist/index.html missing')
}

if (!fs.existsSync(distFaviconPath)) {
  fail('dist/favicon.svg missing')
}

const indexHtml = fs.readFileSync(distIndexPath, 'utf8')

if (!indexHtml.includes(assetPrefix)) {
  fail(`dist/index.html missing ${assetPrefix} references`)
}

if (indexHtml.includes('/src/main.tsx')) {
  fail('dist/index.html still references /src/main.tsx')
}

console.log(`dist checks passed for base path ${normalizedBasePath}`)
