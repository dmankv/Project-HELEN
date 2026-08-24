/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * When VITE_DAEMON_API_URL is set at build time the frontend makes fetch()
 * requests to a cross-origin server.  The inline Content-Security-Policy in
 * index.html must allow that origin in its connect-src directive; otherwise
 * every browser will block the request with a CSP violation.
 *
 * This plugin reads the chat and optional auth API URLs at build time, extracts
 * their origins (e.g. https://api.example.com), and patches connect-src in the
 * built HTML. Legacy VITE_HELEN_* variables remain available during migration.
 */
function daemonCspPlugin() {
  const apiUrls = [
    process.env.VITE_DAEMON_API_URL ?? process.env.VITE_HELEN_API_URL,
    process.env.VITE_DAEMON_AUTH_API_URL ?? process.env.VITE_HELEN_AUTH_API_URL,
  ]
  const extraOrigins = new Set<string>()

  for (const apiUrl of apiUrls) {
    if (!apiUrl) continue
    try {
      extraOrigins.add(new URL(apiUrl).origin)
    } catch {
      // Malformed configured URLs do not weaken the default CSP.
    }
  }

  return {
    name: 'daemon-csp',
    transformIndexHtml(html: string): string {
      if (extraOrigins.size === 0) return html
      return html.replace(
        /connect-src 'self'([^;]*)/,
        (_match, existingSources: string) =>
          `connect-src 'self'${existingSources} ${[...extraOrigins].join(' ')}`,
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
