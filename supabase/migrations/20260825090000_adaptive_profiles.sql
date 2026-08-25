-- Migration: adaptive_profiles + adaptive_evidence
-- Idempotent. Creates the private, per-user storage backing Daemon's adaptive
-- intelligence layer.
--
-- Scope limits enforced by policy (application layer + this schema):
--   • Only allowlisted preference keys/values are ever written
--     (see src/services/daemonAdaptiveProfile.ts).
--   • No sensitive categories are stored: no credentials, payment data,
--     government IDs, precise location, medical/legal details, political
--     profiles, or relationship-dependency signals.
--   • Explicit user settings in user_personality_preferences always override
--     anything inferred here.
--   • RLS is owner-only for select/insert/update/delete, and user_id is
--     immutable after insert so records cannot be reassigned.

-- ── adaptive_profiles ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.adaptive_profiles (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Array of allowlisted AdaptivePreference objects. Schema validation lives
  -- in the application layer so the allowlist can evolve without migrations.
  preferences    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  learning_enabled BOOLEAN   NOT NULL DEFAULT true,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  policy_version INTEGER     NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adaptive_profiles_user_id_idx
  ON public.adaptive_profiles (user_id);

-- ── adaptive_evidence ────────────────────────────────────────────────────────
-- One row per feedback signal that contributed to an inferred preference.
-- Kept so every inference can be explained back to the user.

CREATE TABLE IF NOT EXISTS public.adaptive_evidence (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  preference_key TEXT        NOT NULL,
  value          TEXT        NOT NULL,
  interaction_id TEXT,
  is_positive    BOOLEAN     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adaptive_evidence_user_id_idx
  ON public.adaptive_evidence (user_id);

CREATE INDEX IF NOT EXISTS adaptive_evidence_user_key_idx
  ON public.adaptive_evidence (user_id, preference_key);

-- ── Ownership immutability triggers ──────────────────────────────────────────
-- Prevent any UPDATE from reassigning a row to a different user.

CREATE OR REPLACE FUNCTION public.prevent_adaptive_profile_owner_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'adaptive profile owner is immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_adaptive_profile_immutable_owner
  ON public.adaptive_profiles;

CREATE TRIGGER enforce_adaptive_profile_immutable_owner
  BEFORE UPDATE ON public.adaptive_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_adaptive_profile_owner_change();

CREATE OR REPLACE FUNCTION public.prevent_adaptive_evidence_owner_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'adaptive evidence owner is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_adaptive_evidence_immutable_owner
  ON public.adaptive_evidence;

CREATE TRIGGER enforce_adaptive_evidence_immutable_owner
  BEFORE UPDATE ON public.adaptive_evidence
  FOR EACH ROW EXECUTE FUNCTION public.prevent_adaptive_evidence_owner_change();

-- ── RLS: adaptive_profiles ───────────────────────────────────────────────────

ALTER TABLE public.adaptive_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adaptive_profiles_select_own" ON public.adaptive_profiles;
CREATE POLICY "adaptive_profiles_select_own"
  ON public.adaptive_profiles
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "adaptive_profiles_insert_own" ON public.adaptive_profiles;
CREATE POLICY "adaptive_profiles_insert_own"
  ON public.adaptive_profiles
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "adaptive_profiles_update_own" ON public.adaptive_profiles;
CREATE POLICY "adaptive_profiles_update_own"
  ON public.adaptive_profiles
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "adaptive_profiles_delete_own" ON public.adaptive_profiles;
CREATE POLICY "adaptive_profiles_delete_own"
  ON public.adaptive_profiles
  FOR DELETE
  USING (auth.uid() = user_id);

-- ── RLS: adaptive_evidence ───────────────────────────────────────────────────

ALTER TABLE public.adaptive_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adaptive_evidence_select_own" ON public.adaptive_evidence;
CREATE POLICY "adaptive_evidence_select_own"
  ON public.adaptive_evidence
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "adaptive_evidence_insert_own" ON public.adaptive_evidence;
CREATE POLICY "adaptive_evidence_insert_own"
  ON public.adaptive_evidence
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "adaptive_evidence_update_own" ON public.adaptive_evidence;
CREATE POLICY "adaptive_evidence_update_own"
  ON public.adaptive_evidence
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "adaptive_evidence_delete_own" ON public.adaptive_evidence;
CREATE POLICY "adaptive_evidence_delete_own"
  ON public.adaptive_evidence
  FOR DELETE
  USING (auth.uid() = user_id);

-- No public/anonymous policy is created on either table. Unauthenticated
-- clients cannot read or write adaptive data.
