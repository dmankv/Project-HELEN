export class ResearchDeadline {
  readonly deadline: number
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(timeoutMs: number) {
    const boundedTimeout = Math.max(0, timeoutMs)
    this.deadline = Date.now() + boundedTimeout
    this.signal = this.controller.signal
    this.timer = setTimeout(() => this.controller.abort(), boundedTimeout)
    if (boundedTimeout === 0) this.controller.abort()
  }

  remaining(maximum = Number.POSITIVE_INFINITY): number {
    const remaining = this.deadline - Date.now()
    if (remaining <= 0 || this.signal.aborted) throw new Error('Research deadline exceeded')
    return Math.min(maximum, remaining)
  }

  async run<T>(operation: PromiseLike<T>): Promise<T> {
    this.remaining()
    let removeAbortListener = () => {}
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error('Research deadline exceeded'))
      this.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => this.signal.removeEventListener('abort', onAbort)
    })
    try {
      const result = await Promise.race([Promise.resolve(operation), aborted])
      this.remaining()
      return result
    } finally {
      removeAbortListener()
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
  }
}
