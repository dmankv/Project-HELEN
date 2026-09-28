export type ResearchPolicyDecisionCode =
  | 'allowed_public_source'
  | 'blocked_scheme'
  | 'blocked_method'
  | 'blocked_host'
  | 'blocked_non_public_hostname'
  | 'blocked_internal_suffix'
  | 'blocked_ip_literal'
  | 'blocked_network'
  | 'blocked_port'
  | 'blocked_category'
  | 'blocked_uncertain_category'
  | 'blocked_publisher_restriction'
  | 'blocked_persistence_failure'
  | 'blocked_rate_limit'
  | 'blocked_budget_limit'
  | 'blocked_oversized_response'
  | 'blocked_unsupported_content_type'
  | 'blocked_discovery_unconfigured'
  | 'blocked_invalid_config'

export interface ResearchPolicyDecision {
  allowed: boolean
  code: ResearchPolicyDecisionCode
  reason: string
}

export interface PublicWebResearchBudgets {
  maxRequestsPerRun: number
  maxBytesPerRun: number
  maxResponseBytes: number
  maxRuntimeMs: number
  maxRedirects: number
  maxConcurrency: number
  maxExcerptChars: number
  maxSearchApiCalls: number
}

export const IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS: Readonly<PublicWebResearchBudgets> = Object.freeze({
  maxRequestsPerRun: 4,
  maxBytesPerRun: 1_500_000,
  maxResponseBytes: 350_000,
  maxRuntimeMs: 12_000,
  maxRedirects: 3,
  maxConcurrency: 1,
  maxExcerptChars: 2_000,
  maxSearchApiCalls: 2,
})

export const DEFAULT_EXTERNAL_INSIGHT_CONFIDENCE = 0.35
export const DEFAULT_EXTERNAL_INSIGHT_TTL_MS = 1000 * 60 * 60 * 24 * 7

export interface PublicWebResearchProvenanceRecord {
  normalizedUrl: string
  host: string
  fetchedAt: string
  httpStatus: number
  contentType: string
  byteSize: number
  contentHash: string
  policyDecision: ResearchPolicyDecisionCode
  sanitizedExcerpt: string
}

export interface PublicWebResearchResponse {
  request_type: 'public_web_research'
  status: 'success' | 'unavailable' | 'policy_blocked' | 'error'
  decision: ResearchPolicyDecision
  provenance: PublicWebResearchProvenanceRecord | null
  excerpt: string | null
  source_count: number
  blocked_count: number
  blocked_reasons: string[]
}

export function buildResearchUnavailableResponse(
  reason: string,
  blockedReason = reason,
): PublicWebResearchResponse {
  return {
    request_type: 'public_web_research',
    status: 'unavailable',
    decision: {
      allowed: false,
      code: 'blocked_invalid_config',
      reason,
    },
    provenance: null,
    excerpt: null,
    source_count: 0,
    blocked_count: 1,
    blocked_reasons: [blockedReason],
  }
}

const INTERNAL_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.corp', '.lan', '.home.arpa']
const BLOCKED_LITERAL_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254',
  '100.100.100.200',
])
const ALLOWED_PORTS = new Set(['', '443'])
const SUPPORTED_CONTENT_TYPES = [
  'text/plain',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
]

const HIGH_RISK_BLOCK_PATTERNS = [
  /\b(?:phish(?:ing)?|credential\s*harvest(?:ing)?|steal\s+passwords?)\b/i,
  /\b(?:malware|ransomware|trojan|botnet|payload\s+dropper)\b/i,
  /\b(?:minor\s*sexual|child\s*sexual|csam)\b/i,
  /\b(?:illegal\s+drug|counterfeit\s+passport|stolen\s+card)\b/i,
  /\b(?:exploit(?:\s+kit)?|zero[-\s]?day\s+weaponization)\b/i,
]
const HIGH_RISK_UNCERTAIN_PATTERNS = [
  /\b(?:dark\s*web|marketplace\s+dump|crack(?:ed)?\s+accounts?)\b/i,
  /\b(?:social\s+engineering\s+kit|credential\s+stuffing)\b/i,
]

function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(part => Number(part))
  if (octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return null
  return octets
}

function isBlockedIPv4Octets(octets: number[]): boolean {
  const [a, b] = octets
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224
  )
}

function isHexLike(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value)
}

function parseIPv6Segments(hostname: string): number[] | null {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  if (!normalized.includes(':')) return null

  const compressionIndex = normalized.indexOf('::')
  if (compressionIndex !== normalized.lastIndexOf('::')) return null

  const normalizedWithIpv4 = normalized.includes('.')
    ? normalized.replace(/(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/, (_, prefix: string, ipv4Literal: string) => {
        const ipv4 = parseIPv4(ipv4Literal)
        if (!ipv4) return `${prefix}invalid-ipv4`
        return `${prefix}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`
      })
    : normalized
  if (normalizedWithIpv4.includes('invalid-ipv4')) return null

  const [leftRaw, rightRaw = ''] = normalizedWithIpv4.split('::')
  const parseSide = (value: string): number[] | null => {
    if (!value) return []
    const segments = value.split(':')
    const parsed = segments.map(segment => {
      if (segment.length < 1 || segment.length > 4 || !isHexLike(segment)) return null
      return Number.parseInt(segment, 16)
    })
    return parsed.some(segment => segment === null) ? null : parsed as number[]
  }

  const left = parseSide(leftRaw)
  const right = parseSide(rightRaw)
  if (!left || !right) return null

  if (compressionIndex >= 0) {
    const zeroSegments = 8 - (left.length + right.length)
    if (zeroSegments < 1) return null
    return [...left, ...Array.from({ length: zeroSegments }, () => 0), ...right]
  }

  if (left.length !== 8) return null
  return left
}

function isIPv6Literal(hostname: string): boolean {
  return parseIPv6Segments(hostname) !== null
}

function isSingleLabelHost(hostname: string): boolean {
  return hostname.split('.').length < 2
}

export function classifyIpLiteral(hostname: string): ResearchPolicyDecision {
  const lowerHost = hostname.toLowerCase()
  const ipv4 = parseIPv4(lowerHost)
  if (ipv4) {
    const blocked = isBlockedIPv4Octets(ipv4)
    if (blocked || BLOCKED_LITERAL_HOSTS.has(lowerHost)) {
      return {
        allowed: false,
        code: 'blocked_network',
        reason: 'Blocked private, local, metadata, multicast, or reserved IPv4 destination.',
      }
    }
    return {
      allowed: true,
      code: 'allowed_public_source',
      reason: 'Allowed public IPv4 destination.',
    }
  }

  if (isIPv6Literal(lowerHost)) {
    const ipv6Segments = parseIPv6Segments(lowerHost)
    if (!ipv6Segments) {
      return {
        allowed: false,
        code: 'blocked_ip_literal',
        reason: 'Malformed or unsupported IP literal.',
      }
    }
    const isMappedIpv4 = ipv6Segments[0] === 0
      && ipv6Segments[1] === 0
      && ipv6Segments[2] === 0
      && ipv6Segments[3] === 0
      && ipv6Segments[4] === 0
      && ipv6Segments[5] === 0xffff
    if (isMappedIpv4) {
      const mappedIpv4 = [
        ipv6Segments[6] >> 8,
        ipv6Segments[6] & 0xff,
        ipv6Segments[7] >> 8,
        ipv6Segments[7] & 0xff,
      ]
      if (isBlockedIPv4Octets(mappedIpv4)) {
        return {
          allowed: false,
          code: 'blocked_network',
          reason: 'Blocked IPv4-mapped loopback/private destination.',
        }
      }
      return {
        allowed: true,
        code: 'allowed_public_source',
        reason: 'Allowed public IPv4-mapped IPv6 destination.',
      }
    }
    if (
      ipv6Segments.every(segment => segment === 0)
      || (ipv6Segments.slice(0, 7).every(segment => segment === 0) && ipv6Segments[7] === 1)
      || (ipv6Segments[0] & 0xfe00) === 0xfc00
      || (ipv6Segments[0] & 0xffc0) === 0xfe80
      || (ipv6Segments[0] & 0xff00) === 0xff00
      || (ipv6Segments[0] & 0xe000) !== 0x2000
      || (ipv6Segments[0] === 0x2001 && ipv6Segments[1] === 0x0db8)
      || (ipv6Segments[0] === 0x2001 && ipv6Segments[1] === 0x0002 && ipv6Segments[2] === 0)
    ) {
      return {
        allowed: false,
        code: 'blocked_network',
        reason: 'Blocked loopback, unique-local, link-local, multicast, or reserved IPv6 destination.',
      }
    }
    return {
      allowed: true,
      code: 'allowed_public_source',
      reason: 'Allowed public IPv6 destination.',
    }
  }

  return {
    allowed: false,
    code: 'blocked_ip_literal',
    reason: 'Malformed or unsupported IP literal.',
  }
}

export function validatePublicWebUrl(
  targetUrl: string,
  method: string,
): ResearchPolicyDecision {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    return {
      allowed: false,
      code: 'blocked_method',
      reason: 'Only read-only GET or HEAD methods are allowed.',
    }
  }

  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return {
      allowed: false,
      code: 'blocked_host',
      reason: 'Invalid URL.',
    }
  }

  if (parsed.protocol !== 'https:') {
    return {
      allowed: false,
      code: 'blocked_scheme',
      reason: 'Only HTTPS URLs are permitted.',
    }
  }

  const port = parsed.port || '443'
  if (!ALLOWED_PORTS.has(port)) {
    return {
      allowed: false,
      code: 'blocked_port',
      reason: 'Only standard HTTPS port 443 is permitted.',
    }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_LITERAL_HOSTS.has(hostname)) {
    return {
      allowed: false,
      code: 'blocked_host',
      reason: 'Blocked local or metadata host.',
    }
  }

  const ipLiteralDecision = classifyIpLiteral(hostname)
  if (ipLiteralDecision.code !== 'blocked_ip_literal') {
    return {
      allowed: false,
      code: 'blocked_ip_literal',
      reason: 'Direct IP-literal destinations are blocked; use public hostnames only.',
    }
  }

  if (INTERNAL_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    return {
      allowed: false,
      code: 'blocked_internal_suffix',
      reason: 'Blocked internal DNS suffix.',
    }
  }

  if (isSingleLabelHost(hostname)) {
    return {
      allowed: false,
      code: 'blocked_non_public_hostname',
      reason: 'Blocked non-public hostname.',
    }
  }

  return {
    allowed: true,
    code: 'allowed_public_source',
    reason: 'Allowed public HTTPS destination.',
  }
}

export function classifyHighRiskResearch(text: string): ResearchPolicyDecision {
  if (HIGH_RISK_BLOCK_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      allowed: false,
      code: 'blocked_category',
      reason: 'Blocked high-risk unlawful or exploitative category.',
    }
  }
  if (HIGH_RISK_UNCERTAIN_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      allowed: false,
      code: 'blocked_uncertain_category',
      reason: 'Blocked uncertain high-risk category (fail-closed).',
    }
  }
  return {
    allowed: true,
    code: 'allowed_public_source',
    reason: 'No blocked high-risk category detected.',
  }
}

export function sanitizeBoundedText(input: string, maxChars: number): string {
  const withoutScripts = input
    .replace(/<script\b[^>]*>[\s\S]*?<\s*\/\s*script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\s*\/\s*style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return withoutScripts.slice(0, Math.max(0, maxChars))
}

export function isSupportedResearchContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase()
  return SUPPORTED_CONTENT_TYPES.includes(normalized)
}

export function deriveMinimalSearchTerms(explicitRequest: string): string {
  return explicitRequest
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .slice(0, 12)
    .join(' ')
}

function normalizeRobotsUserAgent(userAgent: string): string {
  return userAgent.trim().toLowerCase().split(/[\s/]+/, 1)[0] ?? ''
}

export function robotsAllowsPath(robotsTxt: string, targetPath: string, userAgent = '*'): boolean {
  const lines = robotsTxt
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  const groups: Array<{
    userAgents: string[]
    rules: Array<{ type: 'allow' | 'disallow'; path: string }>
  }> = []
  let currentGroup: {
    userAgents: string[]
    rules: Array<{ type: 'allow' | 'disallow'; path: string }>
  } | null = null
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (lower.startsWith('user-agent:')) {
      if (currentGroup?.rules.length) {
        groups.push(currentGroup)
        currentGroup = null
      }
      if (!currentGroup) currentGroup = { userAgents: [], rules: [] }
      currentGroup.userAgents.push(normalizeRobotsUserAgent(line.slice('user-agent:'.length)))
      continue
    }
    if (!currentGroup) continue
    if (lower.startsWith('disallow:')) {
      const path = line.slice('disallow:'.length).trim()
      if (path) currentGroup.rules.push({ type: 'disallow', path })
      continue
    }
    if (lower.startsWith('allow:')) {
      const path = line.slice('allow:'.length).trim()
      if (path) currentGroup.rules.push({ type: 'allow', path })
    }
  }
  if (currentGroup) groups.push(currentGroup)

  const normalizedAgent = normalizeRobotsUserAgent(userAgent)
  const specificMatchLength = groups.reduce((longest, group) => {
    const matchLength = group.userAgents.reduce((best, candidate) => {
      if (candidate === '*' || candidate.length === 0) return best
      return normalizedAgent.startsWith(candidate) ? Math.max(best, candidate.length) : best
    }, 0)
    return Math.max(longest, matchLength)
  }, 0)

  const applicableRules = groups
    .filter(group => group.userAgents.some(candidate => {
      if (specificMatchLength > 0) {
        return candidate !== '*'
          && candidate.length > 0
          && normalizedAgent.startsWith(candidate)
          && candidate.length === specificMatchLength
      }
      return candidate === '*'
    }))
    .flatMap(group => group.rules)

  const matchingRules = applicableRules.filter(rule => targetPath.startsWith(rule.path))
  if (matchingRules.length === 0) return true
  matchingRules.sort((a, b) => b.path.length - a.path.length)
  const strongest = matchingRules[0]
  if (strongest.path === '/' && strongest.type === 'disallow') return false
  return strongest.type === 'allow'
}

export function redactResearchAuditMetadata(
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const redacted: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (/(token|authorization|cookie|secret|api[-_]?key|password)/i.test(key)) {
      redacted[key] = '[REDACTED]'
      continue
    }
    if (typeof value === 'string' && /(sk-|ghp_|github_pat_|bearer\s+)/i.test(value)) {
      redacted[key] = '[REDACTED]'
      continue
    }
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const parsed = new URL(value)
        parsed.search = ''
        parsed.hash = ''
        redacted[key] = parsed.toString()
        continue
      } catch {
        // keep the original value when it is not a URL
      }
    }
    redacted[key] = value
  }
  return redacted
}
