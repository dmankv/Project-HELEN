interface Connection {
  read(buffer: Uint8Array): Promise<number | null>
  write(buffer: Uint8Array): Promise<number>
  close(): void
}

declare const Deno: {
  connect(options: { hostname: string; port: number }): Promise<Connection>
  startTls(connection: Connection, options: { hostname: string }): Promise<Connection & { handshake(): Promise<void> }>
}

export interface PinnedResearchResult {
  status: number
  headers: Map<string, string>
  body: Uint8Array
}

export async function fetchPinnedResearch(
  url: URL,
  address: string,
  method: 'GET' | 'HEAD',
  maxBytes: number,
  deadline: number,
): Promise<PinnedResearchResult> {
  let connection: Connection | undefined
  const timed = async <T>(work: Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Research deadline exceeded')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            connection?.close()
            reject(new Error('Research deadline exceeded'))
          }, remaining)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    if (Date.now() >= deadline) throw new Error('Research deadline exceeded')
    connection = await timed(Deno.connect({ hostname: address, port: 443 }).then(conn => {
      if (Date.now() >= deadline) {
        conn.close()
        throw new Error('Research deadline exceeded')
      }
      return conn
    }))
    const tls = await timed(Deno.startTls(connection, { hostname: url.hostname }).then(conn => {
      if (Date.now() >= deadline) {
        conn.close()
        throw new Error('Research deadline exceeded')
      }
      return conn
    }))
    connection = tls
    await timed(tls.handshake())
    const path = `${url.pathname || '/'}${url.search}`
    const request = new TextEncoder().encode(
      `${method} ${path} HTTP/1.1\r\nHost: ${url.hostname}\r\nUser-Agent: DaemonResearchBot/1.0 (+https://dmankv.github.io/Project-HELEN)\r\nAccept: text/plain, text/html, application/json, application/xml\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
    )
    for (let offset = 0; offset < request.length;) {
      const written = await timed(tls.write(request.subarray(offset)))
      if (written <= 0) throw new Error('Research connection closed')
      offset += written
    }

    let pending = new Uint8Array(0)
    let total = 0
    const readMore = async () => {
      const chunk = new Uint8Array(8192)
      const count = await timed(tls.read(chunk))
      if (count === null) throw new Error('Truncated research response')
      if (count === 0) throw new Error('Research connection stalled')
      const next = new Uint8Array(pending.length + count)
      next.set(pending)
      next.set(chunk.subarray(0, count), pending.length)
      pending = next
    }
    const take = async (size: number, countBody = true): Promise<Uint8Array> => {
      if (!Number.isSafeInteger(size) || size < 0 || (countBody && size > maxBytes - total)) {
        throw new Error('Research response exceeds budget')
      }
      while (pending.length < size) await readMore()
      const value = pending.slice(0, size)
      pending = pending.slice(size)
      if (countBody) total += size
      return value
    }
    const line = async (): Promise<string> => {
      while (true) {
        const end = pending.findIndex((b, i) => b === 13 && pending[i + 1] === 10)
        if (end >= 0) {
          const value = new TextDecoder('latin1').decode(pending.subarray(0, end))
          pending = pending.slice(end + 2)
          return value
        }
        if (pending.length > 16_384) throw new Error('Research response headers too large')
        await readMore()
      }
    }
    const statusLine = await line()
    const statusMatch = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(statusLine)
    if (!statusMatch || Number(statusMatch[1]) === 101) throw new Error('Invalid research HTTP status')
    const status = Number(statusMatch[1])
    const headers = new Map<string, string>()
    let headerBytes = statusLine.length
    while (true) {
      const entry = await line()
      headerBytes += entry.length + 2
      if (headerBytes > 16_384) throw new Error('Research response headers too large')
      if (!entry) break
      const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(entry)
      if (!match) throw new Error('Invalid research HTTP header')
      const key = match[1].toLowerCase()
      if (key === 'set-cookie') continue
      if (headers.has(key)) throw new Error('Duplicate research HTTP header')
      headers.set(key, match[2].trim())
    }
    if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') {
      throw new Error('Encoded research response refused')
    }
    if (method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)) {
      return { status, headers, body: new Uint8Array(0) }
    }
    const transferEncoding = headers.get('transfer-encoding')
    const contentLength = headers.get('content-length')
    if (transferEncoding && (transferEncoding.toLowerCase() !== 'chunked' || contentLength !== undefined)) {
      throw new Error('Ambiguous research HTTP framing')
    }
    const chunks: Uint8Array[] = []
    if (transferEncoding) {
      while (true) {
        const sizeLine = await line()
        const match = /^([0-9a-fA-F]+)(?:;[^\r\n]*)?$/.exec(sizeLine)
        if (!match) throw new Error('Invalid research chunk')
        const size = Number.parseInt(match[1], 16)
        if (!size) {
          let trailers = 0
          let trailer: string
          while ((trailer = await line())) {
            trailers += trailer.length + 2
            if (trailers > 16_384) throw new Error('Research trailers too large')
          }
          break
        }
        chunks.push(await take(size))
        const end = await take(2, false)
        if (end[0] !== 13 || end[1] !== 10) throw new Error('Invalid research chunk terminator')
      }
    } else if (contentLength !== undefined) {
      if (!/^\d+$/.test(contentLength)) throw new Error('Invalid research content length')
      chunks.push(await take(Number(contentLength)))
    } else {
      while (true) {
        if (pending.length) chunks.push(await take(pending.length))
        const chunk = new Uint8Array(8192)
        const count = await timed(tls.read(chunk))
        if (count === null) break
        if (count > maxBytes - total) throw new Error('Research response exceeds budget')
        total += count
        chunks.push(chunk.slice(0, count))
      }
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    return { status, headers, body }
  } finally {
    connection?.close()
  }
}
