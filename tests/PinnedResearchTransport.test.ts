import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPinnedResearch } from '../supabase/functions/_shared/pinnedResearchTransport'

const originalDeno = (globalThis as Record<string, unknown>).Deno
afterEach(() => {
  ;(globalThis as Record<string, unknown>).Deno = originalDeno
})

function fakeConnection(response: string, handshake: () => Promise<void> = async () => {}) {
  let offset = 0
  const written: number[] = []
  const bytes = new TextEncoder().encode(response)
  const close = vi.fn()
  const connection = {
    close,
    handshake,
    read: async (buffer: Uint8Array) => {
      if (offset >= bytes.length) return null
      const length = Math.min(buffer.length, bytes.length - offset)
      buffer.set(bytes.subarray(offset, offset + length))
      offset += length
      return length
    },
    write: async (buffer: Uint8Array) => {
      written.push(...buffer)
      return buffer.length
    },
  }
  const connect = vi.fn(async () => connection)
  const startTls = vi.fn(async () => connection)
  ;(globalThis as Record<string, unknown>).Deno = { connect, startTls }
  return { close, connect, startTls, written }
}

describe('DNS-pinned research HTTPS transport', () => {
  it('connects only to the selected IP while authenticating the original host', async () => {
    const fake = fakeConnection('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello')
    const result = await fetchPinnedResearch(
      new URL('https://example.com/page?q=1'), '8.8.8.8', 'GET', 100, Date.now() + 1000,
    )
    expect(fake.connect).toHaveBeenCalledWith({ hostname: '8.8.8.8', port: 443 })
    expect(fake.startTls).toHaveBeenCalledWith(expect.anything(), { hostname: 'example.com' })
    expect(new TextDecoder().decode(new Uint8Array(fake.written)))
      .toContain('GET /page?q=1 HTTP/1.1\r\nHost: example.com\r\n')
    expect(new TextDecoder().decode(result.body)).toBe('hello')
    expect(fake.close).toHaveBeenCalled()
  })

  it('handles chunked framing without counting delimiters as response bytes', async () => {
    fakeConnection('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n')
    const result = await fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )
    expect(result.body.length).toBe(5)
  })

  it('rejects oversized and ambiguous responses', async () => {
    fakeConnection('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nexcess')
    await expect(fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )).rejects.toThrow('budget')
    fakeConnection('HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n')
    await expect(fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )).rejects.toThrow('framing')
  })

  it('fails closed when TLS hostname verification fails', async () => {
    const fake = fakeConnection('', async () => { throw new Error('certificate mismatch') })
    await expect(fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )).rejects.toThrow('certificate mismatch')
    expect(fake.close).toHaveBeenCalled()
  })

  it('returns redirects for policy validation instead of following them', async () => {
    const fake = fakeConnection('HTTP/1.1 302 Found\r\nLocation: https://other.example/path\r\nContent-Length: 0\r\n\r\n')
    const result = await fetchPinnedResearch(
      new URL('https://example.com/old'), '8.8.8.8', 'GET', 20, Date.now() + 1000,
    )
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('https://other.example/path')
    expect(fake.connect).toHaveBeenCalledTimes(1)
  })

  it('rejects truncated bodies and encoded content', async () => {
    fakeConnection('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhi')
    await expect(fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )).rejects.toThrow('Truncated')
    fakeConnection('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n')
    await expect(fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )).rejects.toThrow('Encoded')
  })

  it('ignores repeated upstream cookies rather than forwarding or rejecting them', async () => {
    fakeConnection('HTTP/1.1 200 OK\r\nSet-Cookie: first=1\r\nSet-Cookie: second=2\r\nContent-Length: 0\r\n\r\n')
    const result = await fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() + 1000,
    )
    expect(result.status).toBe(200)
    expect(result.headers.has('set-cookie')).toBe(false)
  })

  it('refuses an expired run before connecting', async () => {
    const fake = fakeConnection('')
    await expect(fetchPinnedResearch(
      new URL('https://example.com'), '8.8.8.8', 'GET', 5, Date.now() - 1,
    )).rejects.toThrow('deadline')
    expect(fake.connect).not.toHaveBeenCalled()
  })
})
