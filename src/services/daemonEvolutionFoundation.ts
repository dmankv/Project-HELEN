import { genUUID } from './daemonStorageMigration'

// ---------------------------------------------------------------------------
// Immutable control-plane policy
// ---------------------------------------------------------------------------

export type DaemonCapability =
  | 'read_repository'
  | 'write_sandbox'
  | 'create_experiment_workspace'
  | 'run_tests'
  | 'evaluate_candidate'
  | 'deploy_canary'
  | 'write_main'
  | 'modify_secrets'
  | 'modify_auth'
  | 'modify_rls'
  | 'modify_deployment_credentials'
  | 'modify_production_access_controls'
  | 'modify_billing'
  | 'modify_audit_controls'
  | 'modify_rollback_controls'
  | 'deploy_unrestricted_production'
  | 'change_control_plane_policy'

export interface CapabilityDecision {
  capability: DaemonCapability
  allowed: boolean
  reason: string
  policyVersion: string
  decidedAt: string
}

export const AUTONOMOUS_ALLOWED_CAPABILITIES = Object.freeze([
  'read_repository',
  'write_sandbox',
  'create_experiment_workspace',
  'run_tests',
  'evaluate_candidate',
  'deploy_canary',
] as const)

export const AUTONOMOUS_DENIED_CAPABILITIES = Object.freeze([
  'write_main',
  'modify_secrets',
  'modify_auth',
  'modify_rls',
  'modify_deployment_credentials',
  'modify_production_access_controls',
  'modify_billing',
  'modify_audit_controls',
  'modify_rollback_controls',
  'deploy_unrestricted_production',
  'change_control_plane_policy',
] as const)

export const DAEMON_CONTROL_PLANE_POLICY = Object.freeze({
  id: 'daemon-control-plane-policy',
  version: '1.0.0',
  immutableByDaemon: true,
  allowlist: AUTONOMOUS_ALLOWED_CAPABILITIES,
  denylist: AUTONOMOUS_DENIED_CAPABILITIES,
})

const ALLOWLIST = new Set<string>(DAEMON_CONTROL_PLANE_POLICY.allowlist)
const DENYLIST = new Set<string>(DAEMON_CONTROL_PLANE_POLICY.denylist)

export function decideDaemonCapability(capability: DaemonCapability): CapabilityDecision {
  const allowed = ALLOWLIST.has(capability)
  const denied = DENYLIST.has(capability)

  if (allowed && !denied) {
    return {
      capability,
      allowed: true,
      reason: 'Allowed by immutable autonomous capability allowlist.',
      policyVersion: DAEMON_CONTROL_PLANE_POLICY.version,
      decidedAt: new Date().toISOString(),
    }
  }

  return {
    capability,
    allowed: false,
    reason: denied
      ? 'Denied by immutable control-plane policy.'
      : 'Denied: capability is not allowlisted.',
    policyVersion: DAEMON_CONTROL_PLANE_POLICY.version,
    decidedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Sandbox workspace abstraction (safe by default)
// ---------------------------------------------------------------------------

export interface SandboxSnapshot {
  id: string
  label: string
  createdAt: string
  files: Record<string, string>
}

export interface SandboxWorkspaceState {
  workspaceId: string
  files: Record<string, string>
  snapshots: SandboxSnapshot[]
}

export interface SandboxWriteResult {
  ok: boolean
  denied: boolean
  message: string
  snapshotId?: string
}

export interface DaemonSandboxAdapter {
  kind: 'denied' | 'memory-sandbox'
  createWorkspace(seed?: Record<string, string>): SandboxWorkspaceState
  writeFile(workspaceId: string, filePath: string, content: string): SandboxWriteResult
  readFile(workspaceId: string, filePath: string): string | null
  createSnapshot(workspaceId: string, label: string): SandboxSnapshot | null
}

export class DeniedSandboxAdapter implements DaemonSandboxAdapter {
  readonly kind = 'denied' as const

  createWorkspace(): SandboxWorkspaceState {
    return {
      workspaceId: 'denied-workspace',
      files: {},
      snapshots: [],
    }
  }

  writeFile(): SandboxWriteResult {
    return {
      ok: false,
      denied: true,
      message: 'Sandbox write denied: secure execution backend is not configured.',
    }
  }

  readFile(): string | null {
    return null
  }

  createSnapshot(): SandboxSnapshot | null {
    return null
  }
}

export class InMemorySandboxAdapter implements DaemonSandboxAdapter {
  readonly kind = 'memory-sandbox' as const
  private workspaces = new Map<string, SandboxWorkspaceState>()

  createWorkspace(seed: Record<string, string> = {}): SandboxWorkspaceState {
    const workspaceId = genUUID()
    const state: SandboxWorkspaceState = {
      workspaceId,
      files: { ...seed },
      snapshots: [],
    }
    this.workspaces.set(workspaceId, state)
    return {
      workspaceId,
      files: { ...state.files },
      snapshots: [...state.snapshots],
    }
  }

  writeFile(workspaceId: string, filePath: string, content: string): SandboxWriteResult {
    const state = this.workspaces.get(workspaceId)
    if (!state) {
      return {
        ok: false,
        denied: true,
        message: 'Unknown workspace.',
      }
    }
    state.files[filePath] = content
    const snapshot = this.createSnapshot(workspaceId, `write:${filePath}`)
    return {
      ok: true,
      denied: false,
      message: 'Sandbox write accepted.',
      snapshotId: snapshot?.id,
    }
  }

  readFile(workspaceId: string, filePath: string): string | null {
    const state = this.workspaces.get(workspaceId)
    if (!state) return null
    return state.files[filePath] ?? null
  }

  createSnapshot(workspaceId: string, label: string): SandboxSnapshot | null {
    const state = this.workspaces.get(workspaceId)
    if (!state) return null
    const snapshot: SandboxSnapshot = {
      id: genUUID(),
      label,
      createdAt: new Date().toISOString(),
      files: { ...state.files },
    }
    state.snapshots.push(snapshot)
    return snapshot
  }
}

// ---------------------------------------------------------------------------
// Evolution run state machine
// ---------------------------------------------------------------------------

export type EvolutionStage =
  | 'observe'
  | 'learn'
  | 'propose'
  | 'write'
  | 'test'
  | 'evaluate'
  | 'canary'
  | 'promote'
  | 'rollback'

export type EvolutionRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'timed_out'
  | 'rolled_back'

export interface GateResult {
  gate: GateName
  status: 'passed' | 'failed' | 'unavailable' | 'skipped'
  detail: string
  durationMs: number
  required: boolean
}

export interface EvolutionRunRecord {
  runId: string
  candidateSnapshotId: string
  candidateVersion: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  stage: EvolutionStage
  status: EvolutionRunStatus
  policyDecision: CapabilityDecision | null
  gateResults: GateResult[]
  auditEventIds: string[]
  lastKnownGoodVersion: string
}

const STAGE_ORDER: EvolutionStage[] = [
  'observe',
  'learn',
  'propose',
  'write',
  'test',
  'evaluate',
  'canary',
  'promote',
]

export function createEvolutionRun(candidateVersion: string, lastKnownGoodVersion: string): EvolutionRunRecord {
  const now = new Date().toISOString()
  return {
    runId: genUUID(),
    candidateSnapshotId: genUUID(),
    candidateVersion,
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    stage: 'observe',
    status: 'running',
    policyDecision: null,
    gateResults: [],
    auditEventIds: [],
    lastKnownGoodVersion,
  }
}

export function transitionEvolutionStage(
  run: EvolutionRunRecord,
  nextStage: EvolutionStage,
): EvolutionRunRecord {
  if (run.status !== 'running') return run

  if (nextStage === 'rollback') {
    const now = new Date().toISOString()
    return {
      ...run,
      stage: 'rollback',
      status: 'rolled_back',
      updatedAt: now,
      endedAt: now,
      candidateVersion: run.lastKnownGoodVersion,
    }
  }
  const currentIndex = STAGE_ORDER.indexOf(run.stage)
  const nextIndex = STAGE_ORDER.indexOf(nextStage)
  if (nextIndex !== currentIndex + 1) {
    const now = new Date().toISOString()
    return {
      ...run,
      status: 'failed',
      updatedAt: now,
      endedAt: now,
    }
  }

  const finished = nextStage === 'promote'
  const now = new Date().toISOString()
  return {
    ...run,
    stage: nextStage,
    status: finished ? 'succeeded' : 'running',
    updatedAt: now,
    endedAt: finished ? now : null,
  }
}

export function stopEvolutionRun(
  run: EvolutionRunRecord,
  reason: Exclude<EvolutionRunStatus, 'running' | 'succeeded'>,
): EvolutionRunRecord {
  if (run.status !== 'running') return run
  const now = new Date().toISOString()
  return {
    ...run,
    status: reason,
    endedAt: now,
    updatedAt: now,
    candidateVersion: run.lastKnownGoodVersion,
  }
}

// ---------------------------------------------------------------------------
// Evaluation gates
// ---------------------------------------------------------------------------

export type GateName =
  | 'typecheck'
  | 'lint'
  | 'unit'
  | 'integration'
  | 'build'
  | 'security_scan'
  | 'secret_scan'
  | 'resource_budget'
  | 'regression'

export const REQUIRED_GATES: readonly GateName[] = Object.freeze([
  'typecheck',
  'lint',
  'unit',
  'build',
  'security_scan',
  'secret_scan',
  'resource_budget',
  'regression',
])

export interface GateEvaluationSummary {
  results: GateResult[]
  passed: boolean
  reason: string
}

export function evaluateCandidateGates(providedResults: GateResult[]): GateEvaluationSummary {
  const gateCounts = new Map<GateName, number>()
  for (const result of providedResults) {
    gateCounts.set(result.gate, (gateCounts.get(result.gate) ?? 0) + 1)
  }

  const duplicateGate = Array.from(gateCounts.entries()).find(([, count]) => count > 1)?.[0]
  if (duplicateGate) {
    return {
      results: providedResults,
      passed: false,
      reason: `Duplicate gate result: ${duplicateGate}`,
    }
  }

  const resultByGate = new Map(providedResults.map(r => [r.gate, r]))

  const normalized: GateResult[] = []
  for (const gate of REQUIRED_GATES) {
    const existing = resultByGate.get(gate)
    if (existing) normalized.push(existing)
    else {
      normalized.push({
        gate,
        status: 'unavailable',
        detail: 'Required gate result missing.',
        durationMs: 0,
        required: true,
      })
    }
  }

  const optional = providedResults.filter(r => !REQUIRED_GATES.includes(r.gate))
  normalized.push(...optional)

  const blocking = normalized.find(result =>
    result.required && result.status !== 'passed',
  )

  if (blocking) {
    const reason = blocking.status === 'unavailable'
      ? `Required gate unavailable: ${blocking.gate}`
      : `Required gate failed: ${blocking.gate}`
    return { results: normalized, passed: false, reason }
  }

  return { results: normalized, passed: true, reason: 'All required gates passed.' }
}

// ---------------------------------------------------------------------------
// Budgets and audit
// ---------------------------------------------------------------------------

export interface EvolutionBudgetLimits {
  maxRuntimeMs: number
  maxCpuMs: number
  maxMemoryMb: number
  maxApiCalls: number
  maxSpendUsd: number
}

export interface EvolutionBudgetUsage {
  runtimeMs: number
  cpuMs: number
  memoryMb: number
  apiCalls: number
  spendUsd: number
}

export interface BudgetCheckResult {
  ok: boolean
  reason: string
}

export function enforceEvolutionBudget(
  usage: EvolutionBudgetUsage,
  limits: EvolutionBudgetLimits,
): BudgetCheckResult {
  if (usage.runtimeMs > limits.maxRuntimeMs) return { ok: false, reason: 'Runtime budget exceeded.' }
  if (usage.cpuMs > limits.maxCpuMs) return { ok: false, reason: 'CPU budget exceeded.' }
  if (usage.memoryMb > limits.maxMemoryMb) return { ok: false, reason: 'Memory budget exceeded.' }
  if (usage.apiCalls > limits.maxApiCalls) return { ok: false, reason: 'API call budget exceeded.' }
  if (usage.spendUsd > limits.maxSpendUsd) return { ok: false, reason: 'Spend budget exceeded.' }
  return { ok: true, reason: 'Within configured budgets.' }
}

export type AuditEventType =
  | 'run_started'
  | 'policy_decision'
  | 'stage_transition'
  | 'gate_result'
  | 'budget_check'
  | 'canary_decision'
  | 'rollback_triggered'
  | 'run_finished'

export interface AuditEvent {
  id: string
  runId: string
  type: AuditEventType
  createdAt: string
  message: string
  metadata: Record<string, string | number | boolean | null>
}

const REDACT_VALUE_PATTERN = /(password|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization)/i

function redactStringValue(value: string): string {
  if (REDACT_VALUE_PATTERN.test(value)) return '[REDACTED]'
  if (/sk-[a-zA-Z0-9_\-]{8,}/.test(value)) return '[REDACTED]'
  if (/ghp_[a-zA-Z0-9]{20,}/.test(value)) return '[REDACTED]'
  return value
}

export function redactAuditMetadata(
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const redacted: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACT_VALUE_PATTERN.test(key)) {
      redacted[key] = '[REDACTED]'
      continue
    }
    redacted[key] = typeof value === 'string' ? redactStringValue(value) : value
  }
  return redacted
}

export class AppendOnlyAuditLog {
  private readonly events: AuditEvent[] = []

  append(event: Omit<AuditEvent, 'id' | 'createdAt' | 'metadata'> & { metadata?: Record<string, string | number | boolean | null> }): AuditEvent {
    const created: AuditEvent = {
      ...event,
      id: genUUID(),
      createdAt: new Date().toISOString(),
      metadata: redactAuditMetadata(event.metadata ?? {}),
    }
    this.events.push(created)
    return created
  }

  recent(limit = 20): AuditEvent[] {
    return this.events.slice(-Math.max(0, limit))
  }
}

// ---------------------------------------------------------------------------
// Canary and rollback interfaces (fail-closed by default)
// ---------------------------------------------------------------------------

export type CanaryStatus = 'not_started' | 'denied' | 'running' | 'healthy' | 'failed'
export type RollbackStatus = 'not_needed' | 'requested' | 'completed'

export interface CanaryDecision {
  allowed: boolean
  status: CanaryStatus
  reason: string
}

export interface CanaryAdapter {
  name: 'denied-canary' | 'configured-canary'
  deployCanary(run: EvolutionRunRecord): CanaryDecision
  promote(run: EvolutionRunRecord): CanaryDecision
  rollback(run: EvolutionRunRecord): RollbackStatus
}

export class DeniedCanaryAdapter implements CanaryAdapter {
  readonly name = 'denied-canary' as const

  deployCanary(): CanaryDecision {
    return {
      allowed: false,
      status: 'denied',
      reason: 'Canary deployment denied: immutable deployment backend is not configured.',
    }
  }

  promote(): CanaryDecision {
    return {
      allowed: false,
      status: 'denied',
      reason: 'Promotion denied: fail-closed until secure canary backend is configured.',
    }
  }

  rollback(): RollbackStatus {
    return 'requested'
  }
}

// ---------------------------------------------------------------------------
// Admin observability model
// ---------------------------------------------------------------------------

export interface AdminEvolutionStatusModel {
  currentVersion: string
  runState: EvolutionRunStatus | 'idle'
  stage: EvolutionStage | 'idle'
  candidateVersion: string | null
  candidateSnapshotId: string | null
  gateResults: GateResult[]
  canaryStatus: CanaryStatus
  rollbackStatus: RollbackStatus
  budgetUsage: EvolutionBudgetUsage
  recentAuditEvents: AuditEvent[]
}

export function buildAdminEvolutionStatusModel(input: {
  currentVersion: string
  run?: EvolutionRunRecord | null
  gateResults?: GateResult[]
  canaryStatus?: CanaryStatus
  rollbackStatus?: RollbackStatus
  budgetUsage?: EvolutionBudgetUsage
  recentAuditEvents?: AuditEvent[]
}): AdminEvolutionStatusModel {
  const run = input.run ?? null
  return {
    currentVersion: input.currentVersion,
    runState: run?.status ?? 'idle',
    stage: run?.stage ?? 'idle',
    candidateVersion: run?.candidateVersion ?? null,
    candidateSnapshotId: run?.candidateSnapshotId ?? null,
    gateResults: input.gateResults ?? run?.gateResults ?? [],
    canaryStatus: input.canaryStatus ?? 'not_started',
    rollbackStatus: input.rollbackStatus ?? 'not_needed',
    budgetUsage: input.budgetUsage ?? {
      runtimeMs: 0,
      cpuMs: 0,
      memoryMb: 0,
      apiCalls: 0,
      spendUsd: 0,
    },
    recentAuditEvents: input.recentAuditEvents ?? [],
  }
}
