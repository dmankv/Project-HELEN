import { describe, expect, it } from 'vitest'
import {
  AppendOnlyAuditLog,
  buildAdminEvolutionStatusModel,
  ConfiguredCanaryAdapter,
  ConfiguredSandboxAdapter,
  createEvolutionInfrastructureAdapters,
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

const REQUIRED_GATES_FOR_TESTS = [
  'typecheck',
  'lint',
  'unit',
  'build',
  'security_scan',
  'secret_scan',
  'resource_budget',
  'regression',
] as const

function passingRequiredGateResults(): GateResult[] {
  return REQUIRED_GATES_FOR_TESTS.map(gate => ({
    gate,
    status: 'passed',
    detail: `${gate} passed`,
    durationMs: 1,
    required: true,
  }))
}

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

  it('configured sandbox stays fail-closed when backend is disabled', () => {
    const adapter = new ConfiguredSandboxAdapter({
      enabled: false,
      backendId: 'immutable-controller',
      maxFileBytes: 1024,
    })
    const workspace = adapter.createWorkspace()
    const write = adapter.writeFile(workspace.workspaceId, 'x.ts', 'export {}')

    expect(workspace.workspaceId).toBe('configured-sandbox-disabled')
    expect(write.ok).toBe(false)
    expect(write.denied).toBe(true)
  })

  it('configured sandbox enforces max file bytes when enabled', () => {
    const adapter = new ConfiguredSandboxAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      maxFileBytes: 10,
    })
    const workspace = adapter.createWorkspace()
    const write = adapter.writeFile(workspace.workspaceId, 'x.ts', 'export const value = 123')

    expect(write.ok).toBe(false)
    expect(write.message).toContain('exceeds 10 bytes')
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

  it('allows duplicate optional gate results without blocking required gate evaluation', () => {
    const summary = evaluateCandidateGates([
      {
        gate: 'integration',
        status: 'failed',
        detail: 'optional run 1',
        durationMs: 1,
        required: false,
      },
      {
        gate: 'integration',
        status: 'passed',
        detail: 'optional run 2',
        durationMs: 1,
        required: false,
      },
    ])
    expect(summary.passed).toBe(false)
    expect(summary.reason).toContain('Required gate unavailable')
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

  it('configured canary allows deploy/promote only in valid stage with auto-promote enabled', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })
    const run = transitionEvolutionStage(
      transitionEvolutionStage(
        transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(createEvolutionRun('candidate-v2', 'v1'), 'learn'),
              'propose',
            ),
            'write',
          ),
          'test',
        ),
        'evaluate',
      ),
      'canary',
    )
    const canaryDecision = adapter.deployCanary(run)
    expect(canaryDecision.allowed).toBe(true)

    const promoteRun = {
      ...run,
      stage: 'promote' as const,
      gateResults: passingRequiredGateResults(),
    }
    const promoteDecision = adapter.promote(promoteRun)
    expect(promoteDecision.allowed).toBe(true)
    expect(adapter.rollback(promoteRun)).toBe('completed')
  })

  it('configured canary still denies promotion when immutable gate requires manual approval', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: false,
    })
    const run = transitionEvolutionStage(
      transitionEvolutionStage(
        transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(createEvolutionRun('candidate-v2', 'v1'), 'learn'),
              'propose',
            ),
            'write',
          ),
          'test',
        ),
        'evaluate',
      ),
      'canary',
    )
    const promoteRun = {
      ...run,
      stage: 'promote' as const,
      gateResults: passingRequiredGateResults(),
    }
    const decision = adapter.promote(promoteRun)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('manual promotion gate')
  })

  it('configured canary denies promotion when required gates are not passed', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })
    const run = transitionEvolutionStage(
      transitionEvolutionStage(
        transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(createEvolutionRun('candidate-v2', 'v1'), 'learn'),
              'propose',
            ),
            'write',
          ),
          'test',
        ),
        'evaluate',
      ),
      'canary',
    )
    const promoteRun = { ...run, stage: 'promote' as const, gateResults: [] }
    const decision = adapter.promote(promoteRun)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('required evaluation gates')
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

describe('evolution infrastructure adapter creation', () => {
  it('defaults to denied adapters when config is absent', () => {
    const adapters = createEvolutionInfrastructureAdapters({})
    expect(adapters.sandbox.kind).toBe('denied')
    expect(adapters.canary.name).toBe('denied-canary')
  })

  it('creates configured adapters only with configured mode and backend id', () => {
    const adapters = createEvolutionInfrastructureAdapters({
      DAEMON_EVOLUTION_SANDBOX_MODE: 'configured',
      DAEMON_EVOLUTION_CANARY_MODE: 'configured',
      DAEMON_EVOLUTION_BACKEND_ID: 'immutable-controller',
      DAEMON_EVOLUTION_ALLOW_AUTO_PROMOTE: 'true',
      DAEMON_EVOLUTION_MAX_FILE_BYTES: '512',
    })
    expect(adapters.sandbox.kind).toBe('configured-sandbox')
    expect(adapters.canary.name).toBe('configured-canary')
  })
})
