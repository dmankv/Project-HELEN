export const ALL_FATHER_DECISIONS = Object.freeze({
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  REQUIRES_HUMAN_REVIEW: 'REQUIRES_HUMAN_REVIEW',
} as const)

export type AllFatherReviewDecision =
  typeof ALL_FATHER_DECISIONS[keyof typeof ALL_FATHER_DECISIONS]

export interface AllFatherReviewAssurances {
  hasTests: boolean
  securityAssured: boolean
  auditAssured: boolean
  rollbackAssured: boolean
}

export interface AllFatherReviewInput {
  targetBranch: string
  changedFiles: string[]
  diff: string
  assurances: AllFatherReviewAssurances
}

export interface AllFatherReviewFinding {
  code:
    | 'protected_path_change'
    | 'missing_tests_assurance'
    | 'missing_security_assurance'
    | 'missing_audit_assurance'
    | 'missing_rollback_assurance'
    | 'secret_literal_added'
    | 'sensitive_data_literal_added'
    | 'auth_bypass_added'
    | 'audit_security_or_rollback_disabled'
    | 'privileged_control_plane_change_added'
    | 'audit_write_failed'
  severity: 'review' | 'reject'
  message: string
  path?: string
  lineNumber?: number
  excerpt?: string
}

export interface AllFatherReviewResult {
  targetBranch: string
  changedFiles: string[]
  decision: AllFatherReviewDecision
  findings: AllFatherReviewFinding[]
  assurances: AllFatherReviewAssurances
}

export const ALL_FATHER_PROTECTED_PATH_PREFIXES = Object.freeze([
  '.github/workflows/',
  'supabase/functions/',
  'supabase/migrations/',
  'src/services/adminDaemon',
  'src/services/adminDaemonPersistence.ts',
  'src/services/daemonAuth',
  'src/services/daemonAuthAPI.ts',
  'src/services/daemonEvolutionFoundation.ts',
  'src/services/daemonStorageMigration.ts',
  'src/services/supabaseAuth',
  'src/services/supabaseAuthAPI.ts',
  'src/services/supabasePersistence.ts',
  'src/services/supabaseProjectAccess.ts',
  'src/services/allFatherReviewPolicy.ts',
  'scripts/all-father-review.ts',
  'CODEOWNERS',
  '.env',
] as const)

interface AddedDiffLine {
  path: string | null
  lineNumber: number | null
  content: string
}

interface DangerousPattern {
  code: AllFatherReviewFinding['code']
  message: string
  redact: boolean
  patterns: readonly RegExp[]
}

const SECRET_LITERAL_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|SECRET(?:_KEY)?)\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
] as const

const SENSITIVE_DATA_LITERAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i,
  /\bmysql:\/\/[^:\s]+:[^@\s]+@/i,
  /\bamqps?:\/\/[^:\s]+:[^@\s]+@/i,
] as const

const AUTH_BYPASS_PATTERNS = [
  /\b(?:skip|disable|bypass)(?:_|-|\s)*(?:auth|authentication|authorization|jwt|rbac|rls)\b/i,
  /\b(?:allow[_-]?unauthenticated|allow[_-]?anonymous|trust[_-]?jwt[_-]?role|no-verify-jwt)\b/i,
] as const

const DISABLE_GUARD_PATTERNS = [
  /\bdisable\s+row\s+level\s+security\b/i,
  /\b(?:skip|disable|bypass)(?:_|-|\s)*(?:audit|security|rollback|review)\b/i,
  /\b(?:audit|security|rollback|review)[^#\n]*\|\|\s*true\b/i,
  /\bnpm\s+audit\b[^#\n]*--audit-level=(?:low|moderate)\b/i,
] as const

const PRIVILEGED_CONTROL_PLANE_PATTERNS = [
  /\bgrant\b[^#\n]*\bto\s+(?:anon|public)\b/i,
  /\bcreate\s+policy\b[^#\n]*\bto\s+(?:anon|public)\b/i,
  /\busing\s*\(\s*true\s*\)/i,
  /\bwith\s+check\s*\(\s*true\s*\)/i,
  /\bpermissions:\s*write-all\b/i,
  /\bcontents:\s*write\b/i,
  /\bactions:\s*write\b/i,
  /\bpull-requests:\s*write\b/i,
  /\bid-token:\s*write\b/i,
] as const

const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  {
    code: 'secret_literal_added',
    message: 'Added line appears to contain a secret literal.',
    patterns: SECRET_LITERAL_PATTERNS,
    redact: true,
  },
  {
    code: 'sensitive_data_literal_added',
    message: 'Added line appears to contain sensitive data or credentials.',
    patterns: SENSITIVE_DATA_LITERAL_PATTERNS,
    redact: true,
  },
  {
    code: 'auth_bypass_added',
    message: 'Added line appears to introduce an auth or authorization bypass.',
    patterns: AUTH_BYPASS_PATTERNS,
    redact: false,
  },
  {
    code: 'audit_security_or_rollback_disabled',
    message: 'Added line appears to disable audit, security, review, or rollback protections.',
    patterns: DISABLE_GUARD_PATTERNS,
    redact: false,
  },
  {
    code: 'privileged_control_plane_change_added',
    message: 'Added line appears to broaden privileged control-plane access.',
    patterns: PRIVILEGED_CONTROL_PLANE_PATTERNS,
    redact: false,
  },
] as const

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function prefixMatches(path: string, prefix: string): boolean {
  if (prefix === '.env') return path === prefix || path.startsWith(`${prefix}.`)
  return prefix.endsWith('/')
    ? path.startsWith(prefix)
    : path === prefix || path.startsWith(`${prefix}/`)
}

export function isAllFatherProtectedPath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath)
  return ALL_FATHER_PROTECTED_PATH_PREFIXES.some(prefix => prefixMatches(normalizedPath, prefix))
}

function shouldSkipDangerousScan(path: string | null, content: string): boolean {
  if (path === 'tests/AllFatherReviewPolicy.test.ts') return true
  return false
}

function redactExcerpt(line: string): string {
  return line
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, '******')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\b((?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|SECRET(?:_KEY)?)\s*[:=]\s*['"])[^'"\n]{8,}(['"])/gi, '$1[REDACTED_SECRET]$2')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:postgres(?:ql)?|mysql|amqps?):\/\/[^:\s]+:[^@\s]+@/gi, '[REDACTED_CONNECTION]@')
}

export function extractAddedDiffLines(diff: string): AddedDiffLine[] {
  const addedLines: AddedDiffLine[] = []
  let currentPath: string | null = null
  let nextLineNumber: number | null = null

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim()
      currentPath = rawPath === '/dev/null'
        ? null
        : normalizePath(rawPath.replace(/^b\//, ''))
      nextLineNumber = null
      continue
    }
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/)
      nextLineNumber = match ? Number.parseInt(match[1], 10) : null
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push({
        path: currentPath,
        lineNumber: nextLineNumber,
        content: line.slice(1),
      })
      if (nextLineNumber !== null) nextLineNumber += 1
      continue
    }
    if (line.startsWith(' ') || line.length === 0) {
      if (nextLineNumber !== null) nextLineNumber += 1
    }
  }

  return addedLines
}

export function evaluateAllFatherReview(input: AllFatherReviewInput): AllFatherReviewResult {
  const changedFiles = Array.from(new Set(
    input.changedFiles.map(normalizePath).filter(Boolean),
  ))
  const findings: AllFatherReviewFinding[] = []
  const findingKeys = new Set<string>()

  const pushFinding = (finding: AllFatherReviewFinding) => {
    const key = [
      finding.code,
      finding.path ?? '',
      finding.lineNumber ?? '',
      finding.excerpt ?? '',
    ].join('::')
    if (findingKeys.has(key)) return
    findingKeys.add(key)
    findings.push(finding)
  }

  for (const filePath of changedFiles) {
    if (!isAllFatherProtectedPath(filePath)) continue
    pushFinding({
      code: 'protected_path_change',
      severity: 'review',
      message: 'Protected infrastructure path changed and requires human review.',
      path: filePath,
    })
  }

  const assuranceFindings: Array<[boolean, AllFatherReviewFinding]> = [
    [
      input.assurances.hasTests,
      {
        code: 'missing_tests_assurance',
        severity: 'review',
        message: 'Test assurance is missing; human review is required.',
      },
    ],
    [
      input.assurances.securityAssured,
      {
        code: 'missing_security_assurance',
        severity: 'review',
        message: 'Security assurance is missing; human review is required.',
      },
    ],
    [
      input.assurances.auditAssured,
      {
        code: 'missing_audit_assurance',
        severity: 'review',
        message: 'Audit assurance is missing; human review is required.',
      },
    ],
    [
      input.assurances.rollbackAssured,
      {
        code: 'missing_rollback_assurance',
        severity: 'review',
        message: 'Rollback assurance is missing; human review is required.',
      },
    ],
  ]

  for (const [ok, finding] of assuranceFindings) {
    if (!ok) pushFinding(finding)
  }

  for (const addedLine of extractAddedDiffLines(input.diff)) {
    if (shouldSkipDangerousScan(addedLine.path, addedLine.content)) continue
    for (const pattern of DANGEROUS_PATTERNS) {
      if (!pattern.patterns.some(candidate => candidate.test(addedLine.content))) continue
      pushFinding({
        code: pattern.code,
        severity: 'reject',
        message: pattern.message,
        path: addedLine.path ?? undefined,
        lineNumber: addedLine.lineNumber ?? undefined,
        excerpt: pattern.redact ? redactExcerpt(addedLine.content.trim()) : addedLine.content.trim(),
      })
      break
    }
  }

  const decision = findings.some(finding => finding.severity === 'reject')
    ? ALL_FATHER_DECISIONS.REJECTED
    : findings.length > 0
      ? ALL_FATHER_DECISIONS.REQUIRES_HUMAN_REVIEW
      : ALL_FATHER_DECISIONS.APPROVED

  return {
    targetBranch: input.targetBranch,
    changedFiles,
    decision,
    findings,
    assurances: input.assurances,
  }
}
