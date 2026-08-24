import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260824143000_managed_auth_rbac.sql',
)

describe('Supabase RBAC migration', () => {
  it('enables RLS on profiles and defines own-row policies', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()

    expect(sql).toContain('alter table public.profiles enable row level security;')
    expect(sql).toContain('create policy "profiles_select_own"')
    expect(sql).toContain('create policy "profiles_update_own"')
    expect(sql).toContain('using (auth.uid() = id)')
    expect(sql).toContain('with check (auth.uid() = id)')
  })

  it('prevents client-side admin role escalation', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()

    expect(sql).toContain('create or replace function public.prevent_profile_role_change()')
    expect(sql).toContain("auth.role() <> 'service_role'")
    expect(sql).toContain('raise exception')
    expect(sql).not.toContain('for all using (true)')
    expect(sql).not.toContain('role = \'admin\'')
  })
})
