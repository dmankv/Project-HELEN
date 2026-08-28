# Admin Daemon Architecture

## Overview

Project-HELEN hosts two Daemon instances:

| Feature | Public Daemon (`#/`) | Admin Daemon (`#/admin-daemon`) |
|---|---|---|
| Access | Anonymous and authenticated users | Authenticated users with `profiles.role = 'admin'` only |
| Route guard | None (public) | Server-side + browser-side |
| Chat storage | `daemon_messages`, `daemon_conversations`, `daemon_active_conv_id` | `daemon_admin_conversations`, `daemon_admin_active_conv_id` |
| Cloud tables | `conversations`, `messages`, `durable_memories`, `learning_interactions` | `admin_conversations`, `admin_messages`, `admin_durable_memories`, `admin_learning_interactions` |
| Edge Function | `daemon-chat` | `admin-daemon` |
| Navigation | Always visible | Visible only to admins |
| Purpose | General-purpose AI assistant for all visitors | Restricted administrative assistant for project administrators |

---

## Routing

| Hash | Renders |
|---|---|
| `#/` (default) | `DaemonInterface` — public Daemon, unchanged |
| `#/admin-daemon` | `AdminDaemonInterface` when admin; `AccessDenied` for non-admin or anon |
| `#/login`, `#/register`, etc. | `LoginView` as before |

The `AccessDenied` page has two states:
- **Anonymous user**: offers a link to sign in and a link back to the public Daemon.
- **Authenticated non-admin user**: offers only a link back to the public Daemon; does not disclose that an admin section exists.

---

## Authorization boundary

The browser route guard is **defence-in-depth only**. The primary authorization boundary is server-side:

1. Every request to the `admin-daemon` Edge Function must carry a valid Supabase JWT in the `Authorization` header.
2. The Edge Function fetches `profiles.role` from the database using a service-role Supabase client. The role is **never** read from the JWT claims or from a browser-supplied field.
3. Any user whose role is not `admin` receives a generic `403 FORBIDDEN` response. No admin capabilities, project data, prompt content, provider configuration, or secret values are leaked.
4. Demotion: if a user's role is changed from `admin` to `user`, their admin rows remain in the database (owned by them) but RLS via the `is_admin()` helper blocks all access until the role is restored.

---

## Data isolation model

Admin data is in dedicated tables (`admin_conversations`, `admin_messages`, `admin_durable_memories`, `admin_learning_interactions`) rather than a shared table with a scope field. This prevents:
- accidental cross-scope queries;
- JOIN leaks that could expose public Daemon history to admins or vice versa;
- RLS policy mistakes that grant overly broad access.

Admin localStorage keys are distinct from public Daemon keys so browser-side storage never mixes.

---

## Permitted admin capabilities

- Safe diagnostics: configuration status, capability availability, version information — no secret values.
- Aggregate evaluation summaries scoped to the admin's own admin-namespace data.
- Admin-owned chat and memory management within the admin namespace.
- Explicit visibility into what the admin has stored; review and delete controls.

## Prohibited capabilities

- Production deployment access.
- Service-role key access or secret inspection from the browser.
- Arbitrary SQL or shell execution.
- Unrestricted access to other users' private conversations or memories.
- Automatic code changes.
- Cross-user data dumps.

---

## Audit / logging

The `admin-daemon` Edge Function emits structured, non-sensitive audit events via `console.info`:

```json
{ "event": "admin_chat", "user_id": "...", "strategy": "...", "context_key": "..." }
```

Raw message content, provider secrets, or full prompts are **never** logged.

---

## Migration and rollback

### Forward migration
Apply `supabase/migrations/20260827190000_admin_daemon.sql` and `supabase/migrations/20260828034000_admin_atomic_rate_limit.sql` from a privileged Supabase context (Dashboard SQL Editor or Supabase CLI with service-role credentials).

### Edge Function deployment
Deploy the Admin Daemon Edge Function after migrations:

```bash
supabase functions deploy admin-daemon --project-ref "$SUPABASE_PROJECT_REF"
```

### Rollback
```sql
drop table if exists public.admin_learning_interactions cascade;
drop table if exists public.admin_durable_memories cascade;
drop table if exists public.admin_messages cascade;
drop table if exists public.admin_conversations cascade;
drop function if exists public.is_admin();
drop function if exists public.prevent_admin_conversation_owner_change();
drop function if exists public.prevent_admin_message_owner_change();
drop function if exists public.prevent_admin_memory_owner_change();
drop function if exists public.prevent_admin_learning_owner_change();
```

Frontend changes can be reverted by reverting `App.tsx` and removing the admin components and service files.

---

## Bootstrapping and revoking admins

Admin role changes must be performed in a privileged Supabase context (Dashboard SQL Editor or Supabase CLI). Normal authenticated users cannot change their own role; the `prevent_profile_role_change` trigger blocks it.

**Grant admin:**
```sql
update public.profiles set role = 'admin' where email = 'admin@example.com';
```

**Revoke admin:**
```sql
update public.profiles set role = 'user' where email = 'admin@example.com';
```

See `supabase/migrations/20260824143000_managed_auth_rbac.sql` for the trigger implementation.
