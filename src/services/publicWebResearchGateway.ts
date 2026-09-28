import {
  IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS,
  validatePublicWebUrl,
  type PublicWebResearchBudgets,
} from '../../supabase/functions/_shared/publicWebResearchPolicy'
import {
  hasEdgeFunction,
  requestPublicWebResearch,
  isEdgeChatFailure,
  type PublicWebResearchRequest,
  type PublicWebResearchResult,
} from './supabaseEdgeChat'

export interface PublicWebResearchGatewayRequest {
  url?: string
  searchQuery?: string
  method?: 'GET' | 'HEAD'
  signal?: AbortSignal
}

export interface QuarantinedPublicWebSource {
  sourceType: 'public-web'
  quarantined: true
  normalizedUrl: string
  host: string
  httpStatus: number
  contentType: string
  byteSize: number
}

export interface PublicWebResearchGatewayResult {
  status: 'success' | 'unavailable' | 'policy_blocked' | 'error'
  quarantined: true
  decision: {
    allowed: boolean
    code: string
    reason: string
  }
  budgets: Readonly<PublicWebResearchBudgets>
  excerpt: string | null
  sources: QuarantinedPublicWebSource[]
  blockedReasons: string[]
}

export interface PublicWebResearchProvider {
  execute: (
    request: PublicWebResearchRequest,
    signal?: AbortSignal,
  ) => Promise<PublicWebResearchResult>
}

function unavailable(reason: string): PublicWebResearchGatewayResult {
  return {
    status: 'unavailable',
    quarantined: true,
    decision: {
      allowed: false,
      code: 'blocked_discovery_unconfigured',
      reason,
    },
    budgets: IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS,
    excerpt: null,
    sources: [],
    blockedReasons: [reason],
  }
}

function policyBlocked(code: string, reason: string): PublicWebResearchGatewayResult {
  return {
    status: 'policy_blocked',
    quarantined: true,
    decision: {
      allowed: false,
      code,
      reason,
    },
    budgets: IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS,
    excerpt: null,
    sources: [],
    blockedReasons: [reason],
  }
}

function resolveProvider(provider?: PublicWebResearchProvider): PublicWebResearchProvider | null {
  if (provider) return provider
  if (!hasEdgeFunction()) return null
  return {
    async execute(request, signal) {
      const result = await requestPublicWebResearch(request, signal)
      if (isEdgeChatFailure(result)) {
        throw new Error(result.category === 'not-signed-in'
          ? 'Sign in is required for vetted public-web research provider.'
          : 'Vetted public-web research provider unavailable.')
      }
      return result
    },
  }
}

function validateRequestUrl(url: string, method: 'GET' | 'HEAD'): ReturnType<typeof validatePublicWebUrl> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, code: 'blocked_host', reason: 'Invalid URL.' }
  }
  if (parsed.username || parsed.password) {
    return { allowed: false, code: 'blocked_host', reason: 'URL credentials are not allowed.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, code: 'blocked_scheme', reason: 'Only HTTP(S) URLs are allowed.' }
  }
  return validatePublicWebUrl(url, method)
}

function toGatewayResult(result: PublicWebResearchResult): PublicWebResearchGatewayResult {
  const source = result.provenance
    ? [{
        sourceType: 'public-web' as const,
        quarantined: true as const,
        normalizedUrl: result.provenance.normalizedUrl,
        host: result.provenance.host,
        httpStatus: result.provenance.httpStatus,
        contentType: result.provenance.contentType,
        byteSize: result.provenance.byteSize,
      }]
    : []
  return {
    status: result.status,
    quarantined: true,
    decision: result.decision,
    budgets: IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS,
    excerpt: result.excerpt,
    sources: source,
    blockedReasons: result.blocked_reasons ?? [],
  }
}

export async function runPublicWebResearchGateway(
  request: PublicWebResearchGatewayRequest,
  options: { provider?: PublicWebResearchProvider } = {},
): Promise<PublicWebResearchGatewayResult> {
  const provider = resolveProvider(options.provider)
  if (!provider) return unavailable('No vetted public-web provider is configured; request quarantined.')

  const method = request.method ?? 'GET'
  if (request.url) {
    const decision = validateRequestUrl(request.url, method)
    if (!decision.allowed) return policyBlocked(decision.code, decision.reason)
  }

  const hasUrl = typeof request.url === 'string' && request.url.trim().length > 0
  const hasSearchQuery = typeof request.searchQuery === 'string' && request.searchQuery.trim().length > 0
  if (!hasUrl && !hasSearchQuery) {
    return policyBlocked('blocked_invalid_config', 'Provide either a URL or a bounded search query.')
  }

  try {
    const result = await provider.execute({
      ...(hasUrl ? { url: request.url?.trim() } : {}),
      ...(hasSearchQuery ? { searchQuery: request.searchQuery?.trim() } : {}),
      method,
      storeInsight: false,
    }, request.signal)
    return toGatewayResult(result)
  } catch (error) {
    const reason = (error as Error).message || 'Public-web research provider unavailable.'
    return unavailable(reason)
  }
}
