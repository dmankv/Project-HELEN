import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260824143000_managed_auth_rbac.sql',
)

describe('Supabase RBAC migration', () => {
  const rawSql = fs.readFileSync(migrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  it('enables RLS on profiles and defines own-row policies', () => {
    expect(normalizedSql).toContain('alter table public.profiles enable row level security;')
    expect(normalizedSql).toContain('create policy "profiles_select_own"')
    expect(normalizedSql).toContain('create policy "profiles_update_own"')
    expect(normalizedSql).toContain('using (auth.uid() = id)')
    expect(normalizedSql).toContain('with check (auth.uid() = id)')
  })

  it('prevents client-side admin role escalation', () => {
    expect(rawSql).toMatch(/create or replace function public\.prevent_profile_role_change\(\)/i)
    expect(rawSql).toMatch(/auth\.role\(\)\s+not in\s+\('service_role',\s*'supabase_admin'\)/i)
    expect(rawSql).toMatch(/session_user\s+not in\s+\('postgres',\s*'supabase_admin'\)/i)
    expect(rawSql).toMatch(/raise exception 'Only provider-side privileged context can change profile role'/i)
    expect(rawSql).not.toMatch(/create policy[\s\S]+for update[\s\S]+with check\s*\(\s*true\s*\)/i)
  })
})
