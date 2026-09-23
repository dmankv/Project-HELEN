import { describe, expect, it } from 'vitest'
import {
  AppendOnlyAuditLog,
  buildAdminEvolutionStatusModel,
  createEvolutionRun,
  decideDaemonCapability,
  DeniedCanaryAdapter,
  DeniedSandboxAdapter,
  enforceEvolutionBudget,
  evaluateCandidateGates,
  InMemorySandboxAdapter,
  transitionEvolutionStage,
  stopEvolutionRun,
  type GateResult,
} from '../src/services/daemonEvolutionFoundation'

describe('daemon evolution foundation policy', () => {
  it('allowlists safe autonomous capabilities and denies privileged ones', () => {
    expect(decideDaemonCapability('read_repository').allowed).toBe(true)
    expect(decideDaemonCapability('write_sandbox').allowed).toBe(true)

    const denied = decideDaemonCapability('write_main')
    expect(denied.allowed).toBe(false)
    expect(denied.reason.toLowerCase()).toContain('denied')
  })
})

describe('sandbox adapters', () => {
  it('fails closed when secure sandbox backend is not configured', () => {
    const adapter = new DeniedSandboxAdapter()
    const workspace = adapter.createWorkspace()
    const write = adapter.writeFile(workspace.workspaceId, 'x.ts', 'export {}')

    expect(workspace.workspaceId).toBe('denied-workspace')
    expect(write.ok).toBe(false)
    expect(write.denied).toBe(true)
    expect(adapter.createSnapshot(workspace.workspaceId, 'attempt')).toBeNull()
  })

  it('supports isolated in-memory sandbox writes with snapshots', () => {
    const adapter = new InMemorySandboxAdapter()
    const workspace = adapter.createWorkspace({ 'a.ts': 'export const a = 1' })

    const write = adapter.writeFile(workspace.workspaceId, 'b.ts', 'export const b = 2')

    expect(write.ok).toBe(true)
    expect(write.snapshotId).toBeTruthy()
    expect(adapter.readFile(workspace.workspaceId, 'a.ts')).toContain('a = 1')
    expect(adapter.readFile(workspace.workspaceId, 'b.ts')).toContain('b = 2')

    const snapshot = adapter.createSnapshot(workspace.workspaceId, 'manual-check')
    expect(snapshot?.files['a.ts']).toContain('a = 1')
    expect(snapshot?.files['b.ts']).toContain('b = 2')
  })
})

describe('evolution run state machine', () => {
  it('supports deterministic staged progression and immutable ids', () => {
    const run = createEvolutionRun('candidate-v2', 'v1')

    expect(run.runId).toBeTruthy()
    expect(run.candidateSnapshotId).toBeTruthy()
    expect(run.stage).toBe('observe')
    expect(run.status).toBe('running')

    const progressed = transitionEvolutionStage(
      transitionEvolutionStage(
        transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(
                transitionEvolutionStage(
                  transitionEvolutionStage(run, 'learn'),
                  'propose',
                ),
                'write',
              ),
              'test',
            ),
            'evaluate',
          ),
          'canary',
        ),
        'promote',
      ),
      'promote',
    )

    expect(progressed.status).toBe('succeeded')
    expect(progressed.stage).toBe('promote')
    expect(progressed.endedAt).toBeTruthy()
  })

  it('stops safely on invalid transitions and keeps last known good version on stop', () => {
    const run = createEvolutionRun('candidate-v2', 'stable-v1')
    const invalid = transitionEvolutionStage(run, 'test')

    expect(invalid.status).toBe('failed')
    expect(invalid.endedAt).toBeTruthy()

    const deniedRun = stopEvolutionRun(createEvolutionRun('candidate-v3', 'stable-v2'), 'denied')
    expect(deniedRun.status).toBe('denied')
    expect(deniedRun.candidateVersion).toBe('stable-v2')
  })

  it('supports rollback transition that restores last known good version', () => {
    const run = createEvolutionRun('candidate-v3', 'stable-v2')
    const rollback = transitionEvolutionStage(run, 'rollback')

    expect(rollback.status).toBe('rolled_back')
    expect(rollback.stage).toBe('rollback')
    expect(rollback.candidateVersion).toBe('stable-v2')
  })
})

describe('candidate evaluation gates', () => {
  it('fails when required gates are unavailable and does not report a false pass', () => {
    const summary = evaluateCandidateGates([])

    expect(summary.passed).toBe(false)
    expect(summary.reason).toContain('Required gate unavailable')
    expect(summary.results.some(r => r.required && r.status === 'unavailable')).toBe(true)
  })

  it('passes only when all required gates pass', () => {
    const requiredGateNames = [
      'typecheck',
      'lint',
      'unit',
      'build',
      'security_scan',
      'secret_scan',
      'resource_budget',
      'regression',
    ] as const

    const gates: GateResult[] = requiredGateNames.map(gate => ({
      gate,
      status: 'passed',
      detail: `${gate} passed`,
      durationMs: 1,
      required: true,
    }))

    const summary = evaluateCandidateGates(gates)
    expect(summary.passed).toBe(true)
  })

  it('fails closed when duplicate required gate results are provided', () => {
    const summary = evaluateCandidateGates([
      {
        gate: 'typecheck',
        status: 'passed',
        detail: 'first',
        durationMs: 1,
        required: true,
      },
      {
        gate: 'typecheck',
        status: 'failed',
        detail: 'second',
        durationMs: 1,
        required: true,
      },
    ])

    expect(summary.passed).toBe(false)
    expect(summary.reason).toContain('Duplicate gate result')
  })
})

describe('budgets, audit redaction, and canary fail-closed behavior', () => {
  it('enforces runtime/api/spend budgets before promotion', () => {
    const exceeded = enforceEvolutionBudget(
      { runtimeMs: 100, cpuMs: 50, memoryMb: 100, apiCalls: 10, spendUsd: 2 },
      { maxRuntimeMs: 90, maxCpuMs: 100, maxMemoryMb: 200, maxApiCalls: 10, maxSpendUsd: 2 },
    )
    expect(exceeded.ok).toBe(false)
    expect(exceeded.reason).toContain('Runtime')

    const within = enforceEvolutionBudget(
      { runtimeMs: 80, cpuMs: 50, memoryMb: 100, apiCalls: 10, spendUsd: 1.9 },
      { maxRuntimeMs: 90, maxCpuMs: 100, maxMemoryMb: 200, maxApiCalls: 10, maxSpendUsd: 2 },
    )
    expect(within.ok).toBe(true)
  })

  it('redacts sensitive audit fields and secrets from stored events', () => {
    const log = new AppendOnlyAuditLog()
    const event = log.append({
      runId: 'run-1',
      type: 'policy_decision',
      message: 'recording policy decision',
      metadata: {
        authToken: 'ghp_12345678901234567890',
        apiKey: 'sk-secret-token',
        detail: 'safe value',
      },
    })

    expect(event.metadata.authToken).toBe('[REDACTED]')
    expect(event.metadata.apiKey).toBe('[REDACTED]')
    expect(event.metadata.detail).toBe('safe value')
  })

  it('refuses canary/promotion by default and requests rollback path', () => {
    const adapter = new DeniedCanaryAdapter()
    const run = createEvolutionRun('candidate-v2', 'v1')

    const canary = adapter.deployCanary(run)
    const promote = adapter.promote(run)

    expect(canary.allowed).toBe(false)
    expect(canary.status).toBe('denied')
    expect(promote.allowed).toBe(false)
    expect(adapter.rollback(run)).toBe('requested')
  })
})

describe('admin observability model', () => {
  it('surfaces status fields needed for admin-only diagnostics view', () => {
    const status = buildAdminEvolutionStatusModel({ currentVersion: 'baseline-safe' })

    expect(status.currentVersion).toBe('baseline-safe')
    expect(status.runState).toBe('idle')
    expect(status.stage).toBe('idle')
    expect(status.canaryStatus).toBe('not_started')
    expect(status.rollbackStatus).toBe('not_needed')
  })
})
