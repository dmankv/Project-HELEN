import { describe, expect, it } from 'vitest'
import {
  AppendOnlyAuditLog,
  buildAdminEvolutionStatusModel,
  completeRollbackRun,
  ConfiguredCanaryAdapter,
  ConfiguredSandboxAdapter,
  completeEvolutionRun,
  createEvolutionInfrastructureAdapters,
  createEvolutionRun,
  decideDaemonCapability,
  DeniedCanaryAdapter,
  DeniedSandboxAdapter,
  enforceEvolutionBudget,
  evaluateCandidateGates,
  InMemorySandboxAdapter,
  recordCanaryDecision,
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

    snapshot!.files['a.ts'] = 'mutated'
    const storedSnapshot = (adapter as { workspaces: Map<string, { snapshots: Array<{ files: Record<string, string> }> }> })
      .workspaces
      .get(workspace.workspaceId)
      ?.snapshots[1]
    expect(storedSnapshot?.files['a.ts']).toContain('a = 1')
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
    const write = adapter.writeFile(workspace.workspaceId, 'src/experimental/x.ts', 'export const value = 123')

    expect(write.ok).toBe(false)
    expect(write.message).toContain('exceeds 10 bytes')
    expect(() => adapter.createWorkspace({ 'src/experimental/seed.ts': 'export const value = 123' })).toThrow('exceeds 10 bytes')
  })

  it('configured sandbox denies protected paths and revalidates snapshots', () => {
    const adapter = new ConfiguredSandboxAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      maxFileBytes: 1024,
    })
    const workspace = adapter.createWorkspace({ 'src/experimental/candidate.ts': 'export {}' })

    const blockedWrite = adapter.writeFile(
      workspace.workspaceId,
      '.github/workflows/evolution-canary.yml',
      'name: compromised',
    )

    expect(blockedWrite).toMatchObject({
      ok: false,
      denied: true,
    })
    expect(blockedWrite.message).toContain('modify_deployment_credentials')
    expect(adapter.writeFile(workspace.workspaceId, 'supabase/functions/admin-daemon/index.ts', 'compromised'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/components/AdminDaemonInterface.tsx', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/App.tsx', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/main.tsx', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/services/daemonAuthAPI.ts', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/services/daemonStorageMigration.ts', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(() => adapter.createWorkspace({ 'supabase/migrations/unsafe.sql': 'select 1' }))
      .toThrow('modify_rls')
    expect(() => adapter.createWorkspace({ 'infrastructure/terraform/main.tf': 'resource "x" "y" {}' }))
      .toThrow('change_control_plane_policy')
    expect(adapter.writeFile(workspace.workspaceId, 'infrastructure/terraform/main.tf', 'resource "x" "y" {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/../infrastructure/terraform/main.tf', 'resource "x" "y" {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, ' src/app.ts', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/My Component.tsx', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })
    expect(adapter.writeFile(workspace.workspaceId, 'src/candidate.ts', 'export {}'))
      .toMatchObject({
        ok: false,
        denied: true,
      })

    const delegate = (adapter as unknown as { delegate: InMemorySandboxAdapter }).delegate
    delegate.writeFile(workspace.workspaceId, '.env.production', 'secret=value')

    expect(adapter.createSnapshot(workspace.workspaceId, 'candidate-evaluation')).toBeNull()
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
      recordCanaryDecision(transitionEvolutionStage(
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
      ), {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }),
      'promote',
    )

    expect(progressed.status).toBe('running')
    expect(progressed.stage).toBe('promote')
    expect(progressed.endedAt).toBeNull()

    const completed = completeEvolutionRun(progressed, {
      allowed: true,
      status: 'healthy',
      reason: 'Promotion accepted.',
    })
    expect(completed.status).toBe('succeeded')
    expect(completed.endedAt).toBeTruthy()
    expect(completed.deployedVersion).toBe('candidate-v2')

    expect(completeEvolutionRun(progressed, {
      allowed: false,
      status: 'denied',
      reason: 'Promotion denied.',
    }).status).toBe('running')
  })

  it('records canary decisions only for active canary runs', () => {
    const decision = {
      allowed: true,
      status: 'healthy' as const,
      reason: 'Canary is healthy.',
    }
    const observeRun = createEvolutionRun('candidate-v2', 'v1')
    const canaryRun = {
      ...observeRun,
      stage: 'canary' as const,
    }
    const failedRun = {
      ...canaryRun,
      status: 'failed' as const,
    }

    expect(recordCanaryDecision(canaryRun, decision).canaryDecision).toMatchObject({
      ...decision,
      runId: canaryRun.runId,
      candidateSnapshotId: canaryRun.candidateSnapshotId,
      candidateVersion: canaryRun.candidateVersion,
    })
    expect(recordCanaryDecision(observeRun, decision)).toBe(observeRun)
    expect(recordCanaryDecision(failedRun, decision)).toBe(failedRun)
  })

  it('does not complete a promote-stage run without a persisted healthy canary decision', () => {
    const progressed = {
      ...createEvolutionRun('candidate-v2', 'stable-v1'),
      stage: 'promote' as const,
    }

    expect(completeEvolutionRun(progressed, {
      allowed: true,
      status: 'healthy',
      reason: 'Promotion accepted.',
    })).toBe(progressed)
  })

  it('ignores invalid transitions and preserves the deployed version on stop', () => {
    const run = createEvolutionRun('candidate-v2', 'stable-v1')
    const invalid = transitionEvolutionStage(run, 'test')

    expect(invalid).toEqual(run)

    const deniedRun = stopEvolutionRun(createEvolutionRun('candidate-v3', 'stable-v2'), 'denied')
    expect(deniedRun.status).toBe('denied')
    expect(deniedRun.candidateVersion).toBe('candidate-v3')
    expect(deniedRun.deployedVersion).toBe('stable-v2')

    const promoted = completeEvolutionRun(
      transitionEvolutionStage(
        recordCanaryDecision(transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(
                transitionEvolutionStage(
                  transitionEvolutionStage(createEvolutionRun('candidate-v4', 'stable-v3'), 'learn'),
                  'propose',
                ),
                'write',
              ),
              'test',
            ),
            'evaluate',
          ),
          'canary',
        ), {
          allowed: true,
          status: 'healthy',
          reason: 'Canary is healthy.',
        }),
        'promote',
      ),
      {
        allowed: true,
        status: 'healthy',
        reason: 'Promotion accepted.',
      },
    )
    const failedRollback = stopEvolutionRun(transitionEvolutionStage(promoted, 'rollback'), 'failed')
    expect(failedRollback.deployedVersion).toBe('candidate-v4')
  })

  it('keeps rollback pending from canary until completion is attested', () => {
    const run = transitionEvolutionStage(
      transitionEvolutionStage(
        transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(createEvolutionRun('candidate-v3', 'stable-v2'), 'learn'),
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
    const rollback = transitionEvolutionStage(run, 'rollback')

    expect(rollback.status).toBe('running')
    expect(rollback.stage).toBe('rollback')
    expect(rollback.endedAt).toBeNull()
    expect(rollback.candidateVersion).toBe('candidate-v3')
    expect(rollback.deployedVersion).toBe('stable-v2')

    const completed = completeRollbackRun(rollback, {
      runId: rollback.runId,
      candidateSnapshotId: rollback.candidateSnapshotId,
      candidateVersion: rollback.candidateVersion,
      deployedVersion: rollback.lastKnownGoodVersion,
    })
    expect(completed.status).toBe('rolled_back')
    expect(completed.endedAt).toBeTruthy()
    expect(completed.deployedVersion).toBe('stable-v2')
  })

  it('does not allow rollback before canary or promotion', () => {
    const run = createEvolutionRun('candidate-v3', 'stable-v2')
    const rollback = transitionEvolutionStage(run, 'rollback')

    expect(rollback).toEqual(run)
  })

  it('does not allow rollback runs to transition back into the staged pipeline', () => {
    const rollback = transitionEvolutionStage({
      ...createEvolutionRun('candidate-v3', 'stable-v2'),
      stage: 'rollback',
    }, 'rollback')

    expect(transitionEvolutionStage(rollback, 'observe')).toBe(rollback)
  })

  it('allows rollback after a successful promotion', () => {
    const promoted = completeEvolutionRun(
      transitionEvolutionStage(
        recordCanaryDecision(transitionEvolutionStage(
          transitionEvolutionStage(
            transitionEvolutionStage(
              transitionEvolutionStage(
                transitionEvolutionStage(
                  transitionEvolutionStage(createEvolutionRun('candidate-v4', 'stable-v3'), 'learn'),
                  'propose',
                ),
                'write',
              ),
              'test',
            ),
            'evaluate',
          ),
          'canary',
        ), {
          allowed: true,
          status: 'healthy',
          reason: 'Canary is healthy.',
        }),
        'promote',
      ),
      {
        allowed: true,
        status: 'healthy',
        reason: 'Promotion accepted.',
      },
    )

    expect(promoted.status).toBe('succeeded')
    expect(promoted.deployedVersion).toBe('candidate-v4')
    const rollback = transitionEvolutionStage(promoted, 'rollback')
    expect(rollback.status).toBe('running')
    expect(rollback.stage).toBe('rollback')
    expect(rollback.deployedVersion).toBe('candidate-v4')
  })

  it('refuses rollback completion without a matching infrastructure attestation', () => {
    const rollback = transitionEvolutionStage({
      ...createEvolutionRun('candidate-v5', 'stable-v4'),
      stage: 'promote',
    }, 'rollback')

    expect(completeRollbackRun(rollback, {
      runId: rollback.runId,
      candidateSnapshotId: rollback.candidateSnapshotId,
      candidateVersion: rollback.candidateVersion,
      deployedVersion: 'unexpected-version',
    })).toBe(rollback)
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

    expect(enforceEvolutionBudget(
      { runtimeMs: Number.NaN, cpuMs: 0, memoryMb: 0, apiCalls: 0, spendUsd: 0 },
      { maxRuntimeMs: 1, maxCpuMs: 1, maxMemoryMb: 1, maxApiCalls: 1, maxSpendUsd: 1 },
    ).ok).toBe(false)
    expect(enforceEvolutionBudget(
      {
        runtimeMs: 1,
        cpuMs: 1,
        memoryMb: 1,
        apiCalls: 1,
      } as unknown as Parameters<typeof enforceEvolutionBudget>[0],
      { maxRuntimeMs: 1, maxCpuMs: 1, maxMemoryMb: 1, maxApiCalls: 1, maxSpendUsd: 1 },
    ).ok).toBe(false)
  })

  it('redacts sensitive audit fields and secrets from stored events', () => {
    const log = new AppendOnlyAuditLog()
    const event = log.append({
      runId: null,
      type: 'policy_decision',
      message: 'recording policy decision',
      metadata: {
        authToken: 'ghp_12345678901234567890',
        apiKey: 'sk-secret-token',
        detail: 'github_pat_123456789012345678901234567890',
        jwt: 'eyJtoken.payload.signature',
        label: 'token status label',
      },
    })

    expect(event.metadata.authToken).toBe('[REDACTED]')
    expect(event.metadata.apiKey).toBe('[REDACTED]')
    expect(event.metadata.detail).toBe('[REDACTED]')
    expect(event.metadata.jwt).toBe('[REDACTED]')
    expect(event.metadata.label).toBe('token status label')
    expect(event.runId).toBeNull()

    event.message = 'mutated'
    event.metadata.detail = 'mutated'
    expect(log.recent()[0]).toMatchObject({
      message: 'recording policy decision',
      metadata: { detail: '[REDACTED]', jwt: '[REDACTED]', label: 'token status label' },
    })
    expect(log.recent(0)).toEqual([])
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

    const promoteRun = transitionEvolutionStage({
      ...recordCanaryDecision(run, canaryDecision),
      gateResults: passingRequiredGateResults(),
      budgetUsage: { runtimeMs: 1, cpuMs: 1, memoryMb: 1, apiCalls: 1, spendUsd: 0.01 },
      budgetLimits: { maxRuntimeMs: 10, maxCpuMs: 10, maxMemoryMb: 10, maxApiCalls: 10, maxSpendUsd: 1 },
    }, 'promote')
    const promoteDecision = adapter.promote(promoteRun)
    expect(promoteDecision.allowed).toBe(true)
    expect(adapter.rollback(promoteRun)).toBe('requested')
  })

  it('configured canary requests rollback when the backend is disabled', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: false,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })

    const canaryRun = transitionEvolutionStage(
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

    expect(adapter.rollback(canaryRun)).toBe('requested')
  })

  it('configured canary reports rollback as not needed for ineligible runs', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })

    expect(adapter.rollback(createEvolutionRun('candidate-v2', 'v1'))).toBe('not_needed')
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
      ...recordCanaryDecision(run, {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }),
      stage: 'promote' as const,
      gateResults: passingRequiredGateResults(),
      budgetUsage: { runtimeMs: 1, cpuMs: 1, memoryMb: 1, apiCalls: 1, spendUsd: 0.01 },
      budgetLimits: { maxRuntimeMs: 10, maxCpuMs: 10, maxMemoryMb: 10, maxApiCalls: 10, maxSpendUsd: 1 },
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
    const promoteRun = {
      ...recordCanaryDecision(run, {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }),
      stage: 'promote' as const,
      gateResults: [],
    }
    const decision = adapter.promote(promoteRun)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('required evaluation gates')
  })

  it('configured canary denies promotion when deployment no longer matches last-known-good', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })
    const canaryRun = transitionEvolutionStage(
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
    const run = {
      ...recordCanaryDecision(canaryRun, {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }),
      stage: 'promote' as const,
      gateResults: passingRequiredGateResults(),
      budgetUsage: { runtimeMs: 1, cpuMs: 1, memoryMb: 1, apiCalls: 1, spendUsd: 0.01 },
      budgetLimits: { maxRuntimeMs: 10, maxCpuMs: 10, maxMemoryMb: 10, maxApiCalls: 10, maxSpendUsd: 1 },
      deployedVersion: 'unexpected-version',
    }

    const decision = adapter.promote(run)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('last-known-good version')
  })

  it('configured canary rejects promotion outside the promote stage before gate checks', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: false,
    })
    const run = {
      ...createEvolutionRun('candidate-v2', 'v1'),
      gateResults: passingRequiredGateResults(),
      budgetUsage: { runtimeMs: 1, cpuMs: 1, memoryMb: 1, apiCalls: 1, spendUsd: 0.01 },
      budgetLimits: { maxRuntimeMs: 10, maxCpuMs: 10, maxMemoryMb: 10, maxApiCalls: 10, maxSpendUsd: 1 },
    }

    const decision = adapter.promote(run)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('not in promote stage')
  })

  it('requires a persisted healthy canary decision before promoting or auto-promoting', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })
    const canaryRun = transitionEvolutionStage(
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

    expect(transitionEvolutionStage(canaryRun, 'promote')).toBe(canaryRun)

    const deniedPromotion = adapter.promote({
      ...canaryRun,
      stage: 'promote',
      gateResults: passingRequiredGateResults(),
      budgetUsage: { runtimeMs: 1, cpuMs: 1, memoryMb: 1, apiCalls: 1, spendUsd: 0.01 },
      budgetLimits: { maxRuntimeMs: 10, maxCpuMs: 10, maxMemoryMb: 10, maxApiCalls: 10, maxSpendUsd: 1 },
    })
    expect(deniedPromotion.allowed).toBe(false)
    expect(deniedPromotion.reason).toContain('healthy canary decision')
  })

  it('fails closed when promotion has no budget state or exceeds a budget', () => {
    const adapter = new ConfiguredCanaryAdapter({
      enabled: true,
      backendId: 'immutable-controller',
      allowAutoPromote: true,
    })
    const run = {
      ...transitionEvolutionStage(recordCanaryDecision({
        ...createEvolutionRun('candidate-v2', 'v1'),
        stage: 'canary',
      }, {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }), 'promote'),
      gateResults: passingRequiredGateResults(),
    }

    expect(adapter.promote(run).reason).toContain('budget usage and limits are required')
    expect(adapter.promote({
      ...run,
      budgetUsage: { runtimeMs: 11, cpuMs: 1, memoryMb: 1, apiCalls: 1, spendUsd: 0.01 },
      budgetLimits: { maxRuntimeMs: 10, maxCpuMs: 10, maxMemoryMb: 10, maxApiCalls: 10, maxSpendUsd: 1 },
    }).reason).toContain('Runtime budget exceeded')
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

  it('falls back to budget usage stored on the active run', () => {
    const status = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: {
        ...createEvolutionRun('candidate-v2', 'baseline-safe'),
        budgetUsage: { runtimeMs: 12, cpuMs: 8, memoryMb: 64, apiCalls: 2, spendUsd: 0.5 },
      },
    })

    expect(status.budgetUsage).toEqual({
      runtimeMs: 12,
      cpuMs: 8,
      memoryMb: 64,
      apiCalls: 2,
      spendUsd: 0.5,
    })
  })

  it('derives canary and rollback defaults from the active run lifecycle state', () => {
    const runningCanary = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: {
        ...createEvolutionRun('candidate-v2', 'baseline-safe'),
        stage: 'canary',
      },
    })
    const promoteReady = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: transitionEvolutionStage(recordCanaryDecision({
        ...createEvolutionRun('candidate-v2', 'baseline-safe'),
        stage: 'canary',
      }, {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }), 'promote'),
    })
    const promoteWithoutCanary = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: {
        ...createEvolutionRun('candidate-v2', 'baseline-safe'),
        stage: 'promote',
      },
    })
    const rolledBack = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: transitionEvolutionStage({
        ...createEvolutionRun('candidate-v2', 'baseline-safe'),
        stage: 'promote',
      }, 'rollback'),
    })
    const rollbackAfterHealthyCanaryRun = transitionEvolutionStage(
      transitionEvolutionStage(recordCanaryDecision({
        ...createEvolutionRun('candidate-v2', 'baseline-safe'),
        stage: 'canary',
      }, {
        allowed: true,
        status: 'healthy',
        reason: 'Canary is healthy.',
      }), 'promote'),
      'rollback',
    )
    const rollbackAfterHealthyCanary = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: rollbackAfterHealthyCanaryRun,
    })
    const completedRollback = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: completeRollbackRun(
        rollbackAfterHealthyCanaryRun,
        {
          runId: rollbackAfterHealthyCanaryRun.runId,
          candidateSnapshotId: rollbackAfterHealthyCanaryRun.candidateSnapshotId,
          candidateVersion: rollbackAfterHealthyCanaryRun.candidateVersion,
          deployedVersion: 'baseline-safe',
        },
      ),
    })

    expect(runningCanary.canaryStatus).toBe('running')
    expect(runningCanary.rollbackStatus).toBe('not_needed')
    expect(promoteReady.canaryStatus).toBe('healthy')
    expect(promoteWithoutCanary.canaryStatus).toBe('failed')
    expect(rolledBack.canaryStatus).toBe('failed')
    expect(rolledBack.rollbackStatus).toBe('requested')
    expect(rollbackAfterHealthyCanary.canaryStatus).toBe('healthy')
    expect(rollbackAfterHealthyCanary.rollbackStatus).toBe('requested')
    expect(completedRollback.canaryStatus).toBe('healthy')
    expect(completedRollback.rollbackStatus).toBe('completed')
    expect(buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run: stopEvolutionRun(createEvolutionRun('candidate-v2', 'baseline-safe'), 'failed'),
    }).canaryStatus).toBe('failed')
  })

  it('falls back to audit events projected from the active run', () => {
    const run = {
      ...createEvolutionRun('candidate-v2', 'baseline-safe'),
      auditEventIds: ['audit-1', 'audit-2'],
    }
    const status = buildAdminEvolutionStatusModel({
      currentVersion: 'baseline-safe',
      run,
    })

    expect(status.recentAuditEvents).toHaveLength(2)
    expect(status.recentAuditEvents.map(event => event.id)).toEqual(['audit-1', 'audit-2'])
    expect(status.recentAuditEvents.every(event => event.runId === run.runId)).toBe(true)
  })
})

describe('evolution infrastructure adapter creation', () => {
  it('defaults to denied adapters when config is absent', () => {
    const adapters = createEvolutionInfrastructureAdapters({})
    expect(adapters.sandbox.kind).toBe('denied')
    expect(adapters.canary.name).toBe('denied-canary')
  })

  it('keeps configured modes denied until verified backends are injected', () => {
    const adapters = createEvolutionInfrastructureAdapters({
      DAEMON_EVOLUTION_SANDBOX_MODE: 'configured',
      DAEMON_EVOLUTION_CANARY_MODE: 'configured',
      DAEMON_EVOLUTION_BACKEND_ID: 'immutable-controller',
      DAEMON_EVOLUTION_ALLOW_AUTO_PROMOTE: 'true',
      DAEMON_EVOLUTION_MAX_FILE_BYTES: '512',
    })
    expect(adapters.sandbox.kind).toBe('configured-sandbox')
    expect(adapters.sandbox.createWorkspace().workspaceId).toBe('configured-sandbox-disabled')
    expect(adapters.canary.name).toBe('configured-canary')
    expect(adapters.canary.promote(createEvolutionRun('candidate-v2', 'v1')).allowed).toBe(false)
  })
})
