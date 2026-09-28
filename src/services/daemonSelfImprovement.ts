import { genUUID } from './daemonStorageMigration'

export interface SelfImprovementAssurances {
  testsPassed: boolean
  securityAssured: boolean
  auditAssured: boolean
  rollbackAssured: boolean
}

export interface SelfImprovementManifestInput {
  sourceBranch: string
  changedFiles: string[]
  purpose: string
  assurances: SelfImprovementAssurances
  proposalId?: string
  createdAt?: string
}

export interface SelfImprovementManifest {
  proposalId: string
  createdAt: string
  sourceBranch: string
  targetBranch: 'main'
  changedFiles: string[]
  purpose: string
  assurances: SelfImprovementAssurances
}

export type SelfImprovementDecisionCode =
  | 'accepted'
  | 'rejected-target-branch'
  | 'rejected-empty-files'
  | 'rejected-purpose'
  | 'rejected-assurance'

export interface SelfImprovementDecision {
  accepted: boolean
  code: SelfImprovementDecisionCode
  reason: string
}

export function createSelfImprovementManifest(input: SelfImprovementManifestInput): SelfImprovementManifest {
  return {
    proposalId: input.proposalId ?? genUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceBranch: input.sourceBranch.trim(),
    targetBranch: 'main',
    changedFiles: input.changedFiles
      .map(path => path.trim())
      .filter(Boolean),
    purpose: input.purpose.trim(),
    assurances: input.assurances,
  }
}

export function evaluateSelfImprovement(manifest: SelfImprovementManifest): SelfImprovementDecision {
  if (manifest.targetBranch !== 'main') {
    return {
      accepted: false,
      code: 'rejected-target-branch',
      reason: 'Self-improvement proposals must target main for ALL-FATHER review.',
    }
  }
  if (!manifest.purpose || manifest.purpose.length < 8) {
    return {
      accepted: false,
      code: 'rejected-purpose',
      reason: 'Self-improvement proposal purpose is missing or too short.',
    }
  }
  if (manifest.changedFiles.length === 0) {
    return {
      accepted: false,
      code: 'rejected-empty-files',
      reason: 'Self-improvement proposal must declare changed files.',
    }
  }
  if (!manifest.assurances.testsPassed
    || !manifest.assurances.securityAssured
    || !manifest.assurances.auditAssured
    || !manifest.assurances.rollbackAssured) {
    return {
      accepted: false,
      code: 'rejected-assurance',
      reason: 'Self-improvement proposal requires tests, security, audit, and rollback assurances.',
    }
  }
  return {
    accepted: true,
    code: 'accepted',
    reason: 'Self-improvement proposal may be submitted for ALL-FATHER review.',
  }
}
