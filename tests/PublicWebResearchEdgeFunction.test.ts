import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildResearchUnavailableResponse } from '../supabase/functions/_shared/publicWebResearchPolicy'

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

  it('reuses the shared fail-closed unavailable response helper for the current transport gate', () => {
    const response = buildResearchUnavailableResponse(
      'Research DNS-pinned transport is not implemented; gateway remains fail-closed.',
      'Research DNS-pinned transport is not implemented.',
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
      blocked_reasons: ['Research DNS-pinned transport is not implemented.'],
    })
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
    expect(sql).toContain('unverified external insight lifecycle requires service-role access')
    expect(sql).toContain('unverified external insight lifecycle transition not permitted')
    expect(sql).toContain('research audit events are append-only')
  })
})
