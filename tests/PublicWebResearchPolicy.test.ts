import { describe, expect, it } from 'vitest'
import {
  IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS,
  classifyHighRiskResearch,
  classifyIpLiteral,
  deriveMinimalSearchTerms,
  isSupportedResearchContentType,
  redactResearchAuditMetadata,
  robotsAllowsPath,
  sanitizeBoundedText,
  validatePublicWebUrl,
} from '../supabase/functions/_shared/publicWebResearchPolicy'

describe('public web research policy', () => {
  it('is fail-closed for unsupported schemes and methods', () => {
    expect(validatePublicWebUrl('http://example.com', 'GET')).toMatchObject({
      allowed: false,
      code: 'blocked_scheme',
    })
    expect(validatePublicWebUrl('https://example.com', 'POST')).toMatchObject({
      allowed: false,
      code: 'blocked_method',
    })
  })

  it('blocks localhost/private networks and unusual ports', () => {
    expect(validatePublicWebUrl('https://localhost', 'GET').allowed).toBe(false)
    expect(validatePublicWebUrl('https://127.0.0.1', 'GET').code).toBe('blocked_network')
    expect(validatePublicWebUrl('https://192.168.1.2', 'GET').code).toBe('blocked_network')
    expect(validatePublicWebUrl('https://example.com:8443', 'GET').code).toBe('blocked_port')
  })

  it('allows public https hostnames with standard port', () => {
    expect(validatePublicWebUrl('https://example.com/path?q=1', 'GET')).toMatchObject({
      allowed: true,
      code: 'allowed_public_source',
    })
  })

  it('classifies ip literals and blocks metadata/local ranges', () => {
    expect(classifyIpLiteral('169.254.169.254').allowed).toBe(false)
    expect(classifyIpLiteral('10.0.0.8').allowed).toBe(false)
    expect(classifyIpLiteral('8.8.8.8').allowed).toBe(true)
    expect(classifyIpLiteral('::1').allowed).toBe(false)
    expect(classifyIpLiteral('::ffff:127.0.0.1').allowed).toBe(false)
    expect(classifyIpLiteral('::ffff:10.0.0.1').allowed).toBe(false)
    expect(classifyIpLiteral('2001:4860:4860::8888').allowed).toBe(true)
  })

  it('blocks explicit and uncertain high-risk categories', () => {
    expect(classifyHighRiskResearch('build credential harvesting phishing page')).toMatchObject({
      allowed: false,
      code: 'blocked_category',
    })
    expect(classifyHighRiskResearch('dark web marketplace dump')).toMatchObject({
      allowed: false,
      code: 'blocked_uncertain_category',
    })
    expect(classifyHighRiskResearch('mdn fetch api docs')).toMatchObject({
      allowed: true,
    })
  })

  it('sanitizes active html content and bounds excerpts', () => {
    const excerpt = sanitizeBoundedText('<script>alert(1)</script><div>Hello <b>world</b></div>', 12)
    expect(excerpt).toBe('Hello world')
  })

  it('applies robots disallow rules for wildcard user-agent', () => {
    const robots = `
      User-agent: *
      Disallow: /private
    `
    expect(robotsAllowsPath(robots, '/private/page')).toBe(false)
    expect(robotsAllowsPath(robots, '/public')).toBe(true)
  })

  it('supports only bounded text-like content types', () => {
    expect(isSupportedResearchContentType('text/html; charset=utf-8')).toBe(true)
    expect(isSupportedResearchContentType('application/json')).toBe(true)
    expect(isSupportedResearchContentType('application/pdf')).toBe(false)
  })

  it('derives minimal search terms from explicit request text only', () => {
    expect(deriveMinimalSearchTerms('Find latest React security docs and mitigations!'))
      .toBe('find latest react security docs and mitigations')
  })

  it('redacts tokens, auth headers, and secrets from audit metadata', () => {
    const redacted = redactResearchAuditMetadata({
      authorization: '******',
      cookie: 'sid=abc',
      apiKey: 'sk-secret',
      safe: 'ok',
    })
    expect(redacted.authorization).toBe('[REDACTED]')
    expect(redacted.cookie).toBe('[REDACTED]')
    expect(redacted.apiKey).toBe('[REDACTED]')
    expect(redacted.safe).toBe('ok')
  })

  it('keeps immutable research budgets bounded and positive', () => {
    expect(IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS.maxRequestsPerRun).toBeGreaterThan(0)
    expect(IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS.maxRedirects).toBeLessThanOrEqual(5)
    expect(IMMUTABLE_PUBLIC_WEB_RESEARCH_BUDGETS.maxResponseBytes).toBeLessThanOrEqual(500_000)
  })
})
