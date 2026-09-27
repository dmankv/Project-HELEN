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

function cloneSandboxSnapshot(snapshot: SandboxSnapshot): SandboxSnapshot {
  return {
    ...snapshot,
    files: { ...snapshot.files },
  }
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
  kind: 'denied' | 'memory-sandbox' | 'configured-sandbox'
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
      snapshots: state.snapshots.map(cloneSandboxSnapshot),
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
    return cloneSandboxSnapshot(snapshot)
  }
}

export interface ConfiguredSandboxAdapterOptions {
  enabled: boolean
  backendId: string
  maxFileBytes: number
}

/**
 * Backend-configured sandbox adapter.
 *
 * Uses the same isolated in-memory workspace model as the local lab adapter,
 * but only when immutable infrastructure has explicitly enabled it.
 */
export class ConfiguredSandboxAdapter implements DaemonSandboxAdapter {
  readonly kind = 'configured-sandbox' as const
  private readonly delegate = new InMemorySandboxAdapter()
  private readonly options: ConfiguredSandboxAdapterOptions

  constructor(options: ConfiguredSandboxAdapterOptions) {
    this.options = options
  }

  private assertWithinMaxFileBytes(filePath: string, content: string): void {
    if (new TextEncoder().encode(content).byteLength > this.options.maxFileBytes) {
      throw new Error(`Sandbox write denied: ${filePath} exceeds ${this.options.maxFileBytes} bytes.`)
    }
  }

  createWorkspace(seed: Record<string, string> = {}): SandboxWorkspaceState {
    if (!this.options.enabled) {
      return {
        workspaceId: 'configured-sandbox-disabled',
        files: {},
        snapshots: [],
      }
    }
    for (const [filePath, content] of Object.entries(seed)) {
      this.assertWithinMaxFileBytes(filePath, content)
    }
    return this.delegate.createWorkspace(seed)
  }

  writeFile(workspaceId: string, filePath: string, content: string): SandboxWriteResult {
    if (!this.options.enabled) {
      return {
        ok: false,
        denied: true,
        message: 'Sandbox write denied: configured backend is disabled by immutable policy.',
      }
    }
    try {
      this.assertWithinMaxFileBytes(filePath, content)
    } catch (error) {
      return {
        ok: false,
        denied: true,
        message: error instanceof Error
          ? error.message
          : `Sandbox write denied: ${filePath} exceeds ${this.options.maxFileBytes} bytes.`,
      }
    }
    return this.delegate.writeFile(workspaceId, filePath, content)
  }

  readFile(workspaceId: string, filePath: string): string | null {
    if (!this.options.enabled) return null
    return this.delegate.readFile(workspaceId, filePath)
  }

  createSnapshot(workspaceId: string, label: string): SandboxSnapshot | null {
    if (!this.options.enabled) return null
    return this.delegate.createSnapshot(workspaceId, `${this.options.backendId}:${label}`)
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
  budgetUsage: EvolutionBudgetUsage | null
  budgetLimits: EvolutionBudgetLimits | null
  auditEventIds: string[]
  lastKnownGoodVersion: string
  deployedVersion: string
  canaryDecision: PersistedCanaryDecision | null
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
    budgetUsage: null,
    budgetLimits: null,
    auditEventIds: [],
    lastKnownGoodVersion,
    deployedVersion: lastKnownGoodVersion,
    canaryDecision: null,
  }
}

export interface PersistedCanaryDecision extends CanaryDecision {
  runId: string
  candidateSnapshotId: string
  candidateVersion: string
}

export interface RollbackCompletionAttestation {
  runId: string
  candidateSnapshotId: string
  candidateVersion: string
  deployedVersion: string
}

function hasHealthyCanaryDecision(run: EvolutionRunRecord): boolean {
  return run.canaryDecision?.allowed === true
    && run.canaryDecision.status === 'healthy'
    && run.canaryDecision.runId === run.runId
    && run.canaryDecision.candidateSnapshotId === run.candidateSnapshotId
    && run.canaryDecision.candidateVersion === run.candidateVersion
}

export function recordCanaryDecision(
  run: EvolutionRunRecord,
  decision: CanaryDecision,
): EvolutionRunRecord {
  const now = new Date().toISOString()
  return {
    ...run,
    updatedAt: now,
    canaryDecision: {
      ...decision,
      runId: run.runId,
      candidateSnapshotId: run.candidateSnapshotId,
      candidateVersion: run.candidateVersion,
    },
  }
}

export function transitionEvolutionStage(
  run: EvolutionRunRecord,
  nextStage: EvolutionStage,
): EvolutionRunRecord {
  if (nextStage === 'rollback') {
    const canRollback = (
      run.status === 'running'
      && (run.stage === 'canary' || run.stage === 'promote')
    ) || (
        run.status === 'succeeded'
        && run.stage === 'promote'
        && run.deployedVersion === run.candidateVersion
      )
    if (!canRollback) return run
    const now = new Date().toISOString()
    return {
      ...run,
      stage: 'rollback',
      status: 'running',
      updatedAt: now,
      endedAt: null,
    }
  }
  if (run.status !== 'running') return run
  if (run.stage === 'canary' && nextStage === 'promote' && !hasHealthyCanaryDecision(run)) return run
  const currentIndex = STAGE_ORDER.indexOf(run.stage)
  const nextIndex = STAGE_ORDER.indexOf(nextStage)
  if (nextIndex !== currentIndex + 1) return run

  const now = new Date().toISOString()
  return {
    ...run,
    stage: nextStage,
    status: 'running',
    updatedAt: now,
    endedAt: null,
  }
}

export function completeEvolutionRun(
  run: EvolutionRunRecord,
  promotionDecision: CanaryDecision,
): EvolutionRunRecord {
  if (
    run.status !== 'running'
    || run.stage !== 'promote'
    || !hasHealthyCanaryDecision(run)
    || !promotionDecision.allowed
    || promotionDecision.status !== 'healthy'
  ) return run
  const now = new Date().toISOString()
  return {
    ...run,
    status: 'succeeded',
    endedAt: now,
    updatedAt: now,
    deployedVersion: run.candidateVersion,
  }
}

export function completeRollbackRun(
  run: EvolutionRunRecord,
  attestation: RollbackCompletionAttestation,
): EvolutionRunRecord {
  if (
    run.status !== 'running'
    || run.stage !== 'rollback'
    || attestation.runId !== run.runId
    || attestation.candidateSnapshotId !== run.candidateSnapshotId
    || attestation.candidateVersion !== run.candidateVersion
    || attestation.deployedVersion !== run.lastKnownGoodVersion
  ) return run
  const now = new Date().toISOString()
  return {
    ...run,
    status: 'rolled_back',
    endedAt: now,
    updatedAt: now,
    deployedVersion: attestation.deployedVersion,
  }
}

export function stopEvolutionRun(
  run: EvolutionRunRecord,
  reason: Exclude<EvolutionRunStatus, 'running' | 'succeeded' | 'rolled_back'>,
): EvolutionRunRecord {
  if (run.status !== 'running') return run
  const now = new Date().toISOString()
  return {
    ...run,
    status: reason,
    endedAt: now,
    updatedAt: now,
    deployedVersion: run.lastKnownGoodVersion,
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
    if (!result.required) continue
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

  const requiredResultByGate = new Map(
    providedResults
      .filter(result => result.required)
      .map(result => [result.gate, result]),
  )

  const normalized: GateResult[] = []
  for (const gate of REQUIRED_GATES) {
    const existing = requiredResultByGate.get(gate)
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

  const optional = providedResults.filter(r => !r.required)
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

function requiredGatesPassed(results: GateResult[]): boolean {
  return evaluateCandidateGates(results).passed
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
  if (
    !Object.values(usage).every(value => Number.isFinite(value) && value >= 0)
    || !Object.values(limits).every(value => Number.isFinite(value) && value >= 0)
  ) {
    return { ok: false, reason: 'Budget usage and limits must be finite and non-negative.' }
  }
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
  runId: string | null
  type: AuditEventType
  createdAt: string
  message: string
  metadata: Record<string, string | number | boolean | null>
}

const REDACT_VALUE_PATTERN = /(password|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization)/i
const REDACT_TOKEN_PATTERNS = [
  /sk-[a-zA-Z0-9_\-]{8,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /github_pat_[a-zA-Z0-9_]{20,}/,
  /eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/,
]

function redactStringValue(value: string): string {
  if (REDACT_TOKEN_PATTERNS.some(pattern => pattern.test(value))) return '[REDACTED]'
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
    return { ...created, metadata: { ...created.metadata } }
  }

  recent(limit = 20): AuditEvent[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : 0
    if (normalizedLimit === 0) return []
    return this.events.slice(-normalizedLimit).map(event => ({
      ...event,
      metadata: { ...event.metadata },
    }))
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

  deployCanary(_run: EvolutionRunRecord): CanaryDecision {
    return {
      allowed: false,
      status: 'denied',
      reason: 'Canary deployment denied: immutable deployment backend is not configured.',
    }
  }

  promote(_run: EvolutionRunRecord): CanaryDecision {
    return {
      allowed: false,
      status: 'denied',
      reason: 'Promotion denied: fail-closed until secure canary backend is configured.',
    }
  }

  rollback(_run: EvolutionRunRecord): RollbackStatus {
    return 'requested'
  }
}

export interface ConfiguredCanaryAdapterOptions {
  enabled: boolean
  backendId: string
  allowAutoPromote: boolean
}

export class ConfiguredCanaryAdapter implements CanaryAdapter {
  readonly name = 'configured-canary' as const
  private readonly options: ConfiguredCanaryAdapterOptions

  constructor(options: ConfiguredCanaryAdapterOptions) {
    this.options = options
  }

  deployCanary(run: EvolutionRunRecord): CanaryDecision {
    if (!this.options.enabled) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Canary deployment denied: configured backend disabled by immutable policy.',
      }
    }
    if (run.status !== 'running' || run.stage !== 'canary') {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Canary deployment denied: run is not in canary stage.',
      }
    }
    return {
      allowed: true,
      status: 'healthy',
      reason: `Canary deployment accepted by backend ${this.options.backendId}.`,
    }
  }

  promote(run: EvolutionRunRecord): CanaryDecision {
    if (!this.options.enabled) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: configured backend disabled by immutable policy.',
      }
    }
    if (run.status !== 'running') {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: run is not active.',
      }
    }
    if (run.stage !== 'promote') {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: run is not in promote stage.',
      }
    }
    if (run.deployedVersion !== run.lastKnownGoodVersion) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: deployment is no longer at the last-known-good version.',
      }
    }
    if (!hasHealthyCanaryDecision(run)) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: a healthy canary decision bound to this run is required.',
      }
    }
    if (!this.options.allowAutoPromote) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: immutable infrastructure requires manual promotion gate.',
      }
    }
    if (!requiredGatesPassed(run.gateResults)) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: required evaluation gates are not fully passed.',
      }
    }
    if (!run.budgetUsage || !run.budgetLimits) {
      return {
        allowed: false,
        status: 'denied',
        reason: 'Promotion denied: budget usage and limits are required.',
      }
    }
    const budget = enforceEvolutionBudget(run.budgetUsage, run.budgetLimits)
    if (!budget.ok) {
      return {
        allowed: false,
        status: 'denied',
        reason: `Promotion denied: ${budget.reason}`,
      }
    }
    return {
      allowed: true,
      status: 'healthy',
      reason: `Promotion accepted by backend ${this.options.backendId}.`,
    }
  }

  rollback(run: EvolutionRunRecord): RollbackStatus {
    const rollbackEligible = (
      run.status === 'running'
      && (run.stage === 'canary' || run.stage === 'promote')
    ) || (
        run.status === 'succeeded'
        && run.stage === 'promote'
        && run.deployedVersion === run.candidateVersion
      )
    if (!rollbackEligible) return 'not_needed'
    return 'requested'
  }
}

export interface EvolutionInfrastructureEnv {
  DAEMON_EVOLUTION_SANDBOX_MODE?: string
  DAEMON_EVOLUTION_CANARY_MODE?: string
  DAEMON_EVOLUTION_BACKEND_ID?: string
  DAEMON_EVOLUTION_MAX_FILE_BYTES?: string
  DAEMON_EVOLUTION_ALLOW_AUTO_PROMOTE?: string
}

export interface EvolutionInfrastructureAdapters {
  sandbox: DaemonSandboxAdapter
  canary: CanaryAdapter
}

const DEFAULT_EVOLUTION_MAX_FILE_BYTES = 16_384

function parseEvolutionMode(value: string | undefined): 'denied' | 'configured' {
  return value?.trim().toLowerCase() === 'configured' ? 'configured' : 'denied'
}

function parseConfiguredBackendId(value: string | undefined): string | null {
  const backendId = value?.trim() ?? ''
  return backendId.length > 0 ? backendId : null
}

function parseConfiguredMaxFileBytes(value: string | undefined): number {
  const parsed = Number(value ?? `${DEFAULT_EVOLUTION_MAX_FILE_BYTES}`)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVOLUTION_MAX_FILE_BYTES
  return Math.floor(parsed)
}

function parseAutoPromote(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/**
 * Creates autonomous evolution adapters from immutable infrastructure config.
 * Unknown/invalid settings always fail closed.
 */
export function createEvolutionInfrastructureAdapters(
  env: EvolutionInfrastructureEnv,
): EvolutionInfrastructureAdapters {
  const sandboxMode = parseEvolutionMode(env.DAEMON_EVOLUTION_SANDBOX_MODE)
  const canaryMode = parseEvolutionMode(env.DAEMON_EVOLUTION_CANARY_MODE)
  const backendId = parseConfiguredBackendId(env.DAEMON_EVOLUTION_BACKEND_ID)
  const maxFileBytes = parseConfiguredMaxFileBytes(env.DAEMON_EVOLUTION_MAX_FILE_BYTES)
  const allowAutoPromote = parseAutoPromote(env.DAEMON_EVOLUTION_ALLOW_AUTO_PROMOTE)

  return {
    sandbox: sandboxMode === 'configured' && backendId
      ? new ConfiguredSandboxAdapter({
          enabled: false,
          backendId,
          maxFileBytes,
        })
      : new DeniedSandboxAdapter(),
    canary: canaryMode === 'configured' && backendId
      ? new ConfiguredCanaryAdapter({
          enabled: false,
          backendId,
          allowAutoPromote,
        })
      : new DeniedCanaryAdapter(),
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

function deriveCanaryStatus(run: EvolutionRunRecord | null): CanaryStatus {
  if (!run) return 'not_started'
  if (run.status === 'failed' || run.status === 'denied' || run.status === 'timed_out') return 'failed'
  if (run.stage === 'rollback' || run.status === 'rolled_back') return 'failed'
  if (hasHealthyCanaryDecision(run)) return 'healthy'
  if (run.stage === 'promote') return 'failed'
  if (run.stage === 'canary') {
    return run.status === 'running'
      ? 'running'
      : 'failed'
  }
  return 'not_started'
}

function deriveRollbackStatus(run: EvolutionRunRecord | null): RollbackStatus {
  if (!run) return 'not_needed'
  if (run.status === 'rolled_back') return 'completed'
  if (run.stage === 'rollback') return 'requested'
  return 'not_needed'
}

function deriveRecentAuditEvents(run: EvolutionRunRecord | null): AuditEvent[] {
  if (!run) return []
  return run.auditEventIds.map(id => ({
    id,
    runId: run.runId,
    type: 'stage_transition',
    createdAt: run.updatedAt,
    message: 'Audit event recorded for this run.',
    metadata: {},
  }))
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
    canaryStatus: input.canaryStatus ?? deriveCanaryStatus(run),
    rollbackStatus: input.rollbackStatus ?? deriveRollbackStatus(run),
    budgetUsage: input.budgetUsage ?? run?.budgetUsage ?? {
      runtimeMs: 0,
      cpuMs: 0,
      memoryMb: 0,
      apiCalls: 0,
      spendUsd: 0,
    },
    recentAuditEvents: input.recentAuditEvents ?? deriveRecentAuditEvents(run),
  }
}
