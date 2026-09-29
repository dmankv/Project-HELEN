import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildResearchUnavailableResponse,
  runPublicWebResearchGateway,
} from '../supabase/functions/_shared/publicWebResearchPolicy'

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

  it('uses a selected-IP pinned transport and fails closed for disabled mode or search discovery', () => {
    expect(src).toContain('fetchPinnedResearch(url, address, fetchMethod')
    expect(src).toContain('resolvePublicResearchAddress(url,')
    expect(src).toContain('fetchRobotsDecision(target, retrieve)')
    expect(src).toContain("evaluation_state: 'quarantined'")
    expect(src).toContain("promotion_state: 'blocked_pending_validation'")
    const response = buildResearchUnavailableResponse(
      'Research search discovery is not configured with a vetted pinned adapter.',
      'Research search discovery is unavailable.',
    )
    expect(response).toMatchObject({
      request_type: 'public_web_research',
      status: 'unavailable',
      decision: {
        allowed: false,
        code: 'blocked_invalid_config',
      },
      provenance: null,
      excerpt: null,
      source_count: 0,
      blocked_count: 1,
      blocked_reasons: ['Research search discovery is unavailable.'],
    })

  })

  it('revalidates robots and redirects before allowing retrieval', async () => {
      const calls: string[] = []
      const result = await runPublicWebResearchGateway(
        new URL('https://example.com/start'),
        'GET',
        2,
        async url => {
          calls.push(url.toString())
          return {
            status: 302,
            headers: new Map([['location', 'https://other.example/final']]),
            body: new Uint8Array(),
          }
        },
        async url => ({
          decision: url.hostname === 'other.example'
            ? { allowed: false, code: 'blocked_publisher_restriction', reason: 'robots denied' }
            : { allowed: true, code: 'allowed_public_source', reason: 'robots allowed' },
          bytes: 0,
        }),
      )
      expect(result).toMatchObject({ decision: { code: 'blocked_publisher_restriction' } })
      expect(calls).toEqual(['https://example.com/start'])
    })

  it('blocks a robots verification failure without calling the source', async () => {
      const retrieve = vi.fn()
      const result = await runPublicWebResearchGateway(
        new URL('https://example.com/private'),
        'GET',
        2,
        retrieve,
        async () => ({
          decision: { allowed: false, code: 'blocked_publisher_restriction', reason: 'robots unavailable' },
          bytes: 0,
        }),
      )
      expect(result).toMatchObject({ decision: { code: 'blocked_publisher_restriction' } })
      expect(retrieve).not.toHaveBeenCalled()
  })

  it('maps research failure catch paths to fixed safe reasons', () => {
    expect(src).toContain("const SAFE_RESEARCH_PERSISTENCE_FAILURE_REASON = 'Research request could not be recorded; request blocked safely.'")
    expect(src).toContain("const SAFE_RESEARCH_RUNTIME_FAILURE_REASON = 'Research request failed safely due to internal policy/runtime handling.'")
    expect(src).toMatch(
      /code:\s*error instanceof ResearchPersistenceError\s*\?\s*'blocked_persistence_failure'\s*:\s*'blocked_invalid_config'/,
    )
    expect(src).toMatch(
      /reason:\s*error instanceof ResearchPersistenceError\s*\?\s*SAFE_RESEARCH_PERSISTENCE_FAILURE_REASON\s*:\s*SAFE_RESEARCH_RUNTIME_FAILURE_REASON/,
    )
    expect(src).toMatch(
      /blocked_reasons:\s*\[\s*error instanceof ResearchPersistenceError\s*\?\s*SAFE_RESEARCH_PERSISTENCE_FAILURE_REASON\s*:\s*SAFE_RESEARCH_RUNTIME_FAILURE_REASON,\s*\]/,
    )
  })
})

describe('public web research migration', () => {
  const rawSql = fs.readFileSync(migrationPath, 'utf8')
  const sql = rawSql.toLowerCase()

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
    expect(sql).toContain('unverified external insight lifecycle requires service-role access')
    expect(sql).toContain('unverified external insight lifecycle transition not permitted')
    expect(sql).toContain('research audit events are append-only')
  })

  it('executes research aggregate rpc as the caller and restricts it to service_role', () => {
    const match = rawSql.match(
      /create or replace function public\.get_research_status_aggregates\(target_user_id uuid\)[\s\S]+?\$\$;/i,
    )
    expect(match).not.toBeNull()
    const fn = match![0].toLowerCase()
    expect(fn).toContain('security invoker')
    expect(fn).toContain("if current_user <> 'service_role' then")
    expect(sql).toContain('grant execute on function public.get_research_status_aggregates(uuid) to service_role;')
  })
})
