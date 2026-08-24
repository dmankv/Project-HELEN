-- Migration: user_personality_preferences
-- Idempotent. Creates a private, per-user personality preferences table.
-- RLS enforces owner-only read/write. The user_id column is immutable after
-- insert so clients cannot reassign records to other users.

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_personality_preferences (
  user_id   UUID    PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Preferences stored as JSONB. Schema validation is enforced in the
  -- application layer (daemonPersonalityPreferences.ts). The column allows
  -- any JSON so the schema can evolve without migrations.
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Ownership immutability trigger ───────────────────────────────────────────
-- Prevent any UPDATE from changing user_id after insert.

CREATE OR REPLACE FUNCTION public.prevent_personality_preferences_user_id_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable on user_personality_preferences';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_personality_preferences_immutable_user_id
  ON public.user_personality_preferences;

CREATE TRIGGER enforce_personality_preferences_immutable_user_id
  BEFORE UPDATE ON public.user_personality_preferences
  FOR EACH ROW EXECUTE FUNCTION public.prevent_personality_preferences_user_id_change();

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_personality_preferences ENABLE ROW LEVEL SECURITY;

-- Users may read their own record only.
DROP POLICY IF EXISTS "personality_preferences_select_own" ON public.user_personality_preferences;
CREATE POLICY "personality_preferences_select_own"
  ON public.user_personality_preferences
  FOR SELECT
  USING (user_id = auth.uid());

-- Users may insert a record for themselves only.
-- The WITH CHECK clause prevents forging a different user_id.
DROP POLICY IF EXISTS "personality_preferences_insert_own" ON public.user_personality_preferences;
CREATE POLICY "personality_preferences_insert_own"
  ON public.user_personality_preferences
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users may update their own record only.
DROP POLICY IF EXISTS "personality_preferences_update_own" ON public.user_personality_preferences;
CREATE POLICY "personality_preferences_update_own"
  ON public.user_personality_preferences
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users may delete their own record only.
DROP POLICY IF EXISTS "personality_preferences_delete_own" ON public.user_personality_preferences;
CREATE POLICY "personality_preferences_delete_own"
  ON public.user_personality_preferences
  FOR DELETE
  USING (user_id = auth.uid());

-- No public/anonymous access policy is created. Unauthenticated users cannot
-- access this table.
