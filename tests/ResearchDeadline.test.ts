import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchDeadline } from '../supabase/functions/_shared/researchDeadline'

afterEach(() => {
  vi.useRealTimers()
})

describe('overall research deadline', () => {
  it('fails immediately when no runtime remains', () => {
    const deadline = new ResearchDeadline(0)
    expect(() => deadline.remaining(3_000)).toThrow('deadline')
    deadline.dispose()
  })

  it('does not impose a 250ms minimum on a near-expired operation', async () => {
    vi.useFakeTimers()
    const deadline = new ResearchDeadline(5)
    const operation = deadline.run(new Promise<never>(() => {}))
    const rejection = expect(operation).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(5)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the same abort signal for sequential robots, redirect, and source work', async () => {
    const deadline = new ResearchDeadline(1_000)
    const seen: AbortSignal[] = []
    const operation = async () => {
      seen.push(deadline.signal)
      await deadline.run(Promise.resolve('robots'))
      seen.push(deadline.signal)
      await deadline.run(Promise.resolve('redirect'))
      seen.push(deadline.signal)
      await deadline.run(Promise.resolve('source'))
    }
    await operation()
    expect(new Set(seen).size).toBe(1)
    deadline.dispose()
  })
})
