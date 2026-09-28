import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const daemonChatPath = path.resolve(process.cwd(), 'supabase/functions/daemon-chat/index.ts')
const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260928070000_public_web_research_gateway.sql',
)

describe('public web research edge gateway source', () => {
  const src = fs.readFileSync(daemonChatPath, 'utf8')

  it('implements explicit public_web_research request type server-side', () => {
    expect(src).toContain("request_type?: 'chat' | 'public_web_research'")
    expect(src).toContain("if (isPublicWebResearchRequest(body))")
    expect(src).toContain('executePublicWebResearch(')
  })

  it('enforces read-only methods and HTTPS-only policy validation', () => {
    expect(src).toContain("validatePublicWebUrl(targetUrl, requestMethod)")
    expect(src).toContain("research.method !== 'GET' && research.method !== 'HEAD'")
  })

  it('revalidates DNS and redirects with immutable budgets', () => {
    expect(src).toContain('ensurePublicDnsResolution(')
    expect(src).toContain("redirect: 'manual'")
    expect(src).toContain('maxRedirects')
    expect(src).toContain('blocked_budget_limit')
  })

  it('sanitizes extracted content and blocks unsupported content types', () => {
    expect(src).toContain('isSupportedResearchContentType(')
    expect(src).toContain('sanitizeBoundedText(')
    expect(src).toContain('blocked_unsupported_content_type')
  })

  it('stores provenance, audit events, and quarantined insights server-side only', () => {
    expect(src).toContain("from('research_fetch_provenance').insert")
    expect(src).toContain("from('research_audit_events').insert")
    expect(src).toContain("from('unverified_external_insights').insert")
    expect(src).toContain("evaluation_state: 'quarantined'")
    expect(src).toContain("promotion_state: 'blocked_pending_validation'")
  })

  it('does not forward caller Authorization or Cookie headers to destination fetches', () => {
    const fetchHeadersBlock = src.match(/const fetchHeaders:[\s\S]+?}\n\s*const response = await fetch/s)?.[0] ?? ''
    expect(fetchHeadersBlock).not.toMatch(/authorization\s*:/i)
    expect(fetchHeadersBlock).not.toMatch(/cookie\s*:/i)
  })
})

describe('public web research migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()

  it('creates provenance, quarantine, and audit tables with RLS', () => {
    expect(sql).toContain('create table if not exists public.research_fetch_provenance')
    expect(sql).toContain('create table if not exists public.unverified_external_insights')
    expect(sql).toContain('create table if not exists public.research_audit_events')
    expect(sql).toContain('alter table public.research_fetch_provenance enable row level security;')
    expect(sql).toContain('alter table public.unverified_external_insights enable row level security;')
    expect(sql).toContain('alter table public.research_audit_events enable row level security;')
  })

  it('keeps lifecycle records append-only and blocks direct mutation', () => {
    expect(sql).toContain('research provenance is append-only')
    expect(sql).toContain('unverified external insights are immutable while promotion remains blocked')
    expect(sql).toContain('research audit events are append-only')
  })
})
