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
    || (a === 192 && b === 168)
    || a >= 224
  )
}

function isHexLike(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value)
}

function isIPv6Literal(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  if (!normalized.includes(':')) return false
  const segments = normalized.split(':')
  return segments.every(segment => segment === '' || isHexLike(segment))
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
    const normalized = lowerHost.replace(/^\[|\]$/g, '')
    const mappedIpv4Match = /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalized)
    if (mappedIpv4Match) {
      const mappedIpv4 = parseIPv4(mappedIpv4Match[1])
      if (!mappedIpv4 || isBlockedIPv4Octets(mappedIpv4)) {
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
      normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized.startsWith('ff')
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
  if (ipLiteralDecision.allowed || ipLiteralDecision.code !== 'blocked_ip_literal') {
    return ipLiteralDecision
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

export function robotsAllowsPath(robotsTxt: string, targetPath: string): boolean {
  const lines = robotsTxt
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  let appliesToAllAgents = false
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (lower.startsWith('user-agent:')) {
      const ua = line.slice('user-agent:'.length).trim()
      appliesToAllAgents = ua === '*'
      continue
    }
    if (!appliesToAllAgents) continue
    if (lower.startsWith('disallow:')) {
      const path = line.slice('disallow:'.length).trim()
      if (path === '/') return false
      if (path && targetPath.startsWith(path)) return false
    }
  }
  return true
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
    redacted[key] = value
  }
  return redacted
}
