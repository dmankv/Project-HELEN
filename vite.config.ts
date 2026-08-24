/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * When VITE_DAEMON_API_URL is set at build time the frontend makes fetch()
 * requests to a cross-origin server.  The inline Content-Security-Policy in
 * index.html must allow that origin in its connect-src directive; otherwise
 * every browser will block the request with a CSP violation.
 *
 * This plugin reads VITE_DAEMON_API_URL at build time, extracts the origin
 * (e.g. https://api.example.com), and patches connect-src in the built HTML.
 * When the variable is unset, connect-src remains 'self' (local-brain mode).
 */
function daemonCspPlugin() {
  const apiUrl = process.env.VITE_DAEMON_API_URL ?? ''
  let extraOrigin = ''
  if (apiUrl) {
    try {
      extraOrigin = new URL(apiUrl).origin
    } catch {
      // malformed VITE_DAEMON_API_URL — fall back to 'self' only
    }
  }

  return {
    name: 'daemon-csp',
    transformIndexHtml(html: string): string {
      if (!extraOrigin) return html
      return html.replace(
        /connect-src 'self'/,
        `connect-src 'self' ${extraOrigin}`,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), daemonCspPlugin()],
  base: '/Project-HELEN/',
  server: {
    port: 3000,
    open: true
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/vitest.setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    typecheck: { tsconfig: './tsconfig.test.json' },
  },
})
