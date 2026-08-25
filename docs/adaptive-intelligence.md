# Daemon Adaptive Intelligence

This document describes Daemon's adaptive-intelligence foundation: what it
learns, what it will never learn, where data lives, and how you stay in
control.

Daemon is a software assistant. **Daemon is not sentient, not conscious, not
human, and not a substitute for human relationships or professional help.**
Nothing in the adaptive layer changes that, and no amount of learned behavior
can make Daemon claim otherwise.

---

## 1. What adaptive learning does

Daemon can adapt three narrow things from your thumbs-up/thumbs-down feedback:

1. **Bounded communication preferences** — a fixed allowlist of keys, each with
   a fixed set of allowed values (`src/services/daemonAdaptiveProfile.ts`):

   | Key | Allowed values |
   | --- | --- |
   | `response_detail_tendency` | `concise`, `balanced`, `detailed` |
   | `directness_preference` | `gentle`, `balanced`, `direct` |
   | `preferred_problem_solving_strategy` | `direct-answer`, `step-by-step-plan`, `tradeoff-options`, `research-and-cite`, `clarify-first` |
   | `follow_up_question_tolerance` | `low`, `medium`, `high` |
   | `desired_structure` | `summary`, `checklist`, `plan`, `narrative` |
   | `humor_preference` | `none`, `light`, `moderate` |
   | `helpful_contexts` | `coding`, `planning`, `emotional-support`, `research`, `general` |

2. **Response strategy scores** — which of a fixed set of approved strategies
   tends to be rated helpful for a given (intent, mood) situation
   (`src/services/daemonResponsePolicy.ts`).

3. **Retrieval relevance** — which stored memories are worth mentioning for the
   current message (`src/services/daemonMemoryRetrieval.ts`).

### Inference rules

- **Minimum evidence:** at least **3** positive signals for the same key/value
  pair before anything is inferred.
- **Negative feedback** reduces confidence; a preference that falls below
  confidence `0.1` is deleted outright.
- **Decay:** feedback-derived preferences **expire after 90 days** without
  reinforcement and are pruned on the next read.
- **Cooldown:** once a value is established, changing it requires **2 or more**
  confirming signals recorded after the current value was set.
- **Explicit confirmations are durable:** they never expire and are never
  overwritten by inference.
- **Confidence never reaches certainty.** An inferred problem-solving strategy
  only steers selection above confidence `0.7`.

## 2. What adaptive learning does **not** do

- It never modifies production code, system prompts, database migrations, RLS
  policies, authentication, or safety policy. Learned state is data, not code.
- It can only *select among already-approved response strategies*. It cannot
  invent new behaviors.
- It never overrides safety, crisis, refusal, or factuality handling.
- It never makes Daemon simulate feelings, consciousness, or a personal life.
- It does not perform web search, shell execution, or arbitrary code execution.
- It uses no vector database and no embeddings — retrieval is deterministic
  lexical overlap plus recency, so every result is reproducible and auditable.

## 3. Data categories prohibited from adaptive storage

The following are **never** retained, inferred, or retrieved. Matching text is
dropped entirely (see `FORBIDDEN_MEMORY_PATTERNS` in
`src/services/daemonMemoryRetrieval.ts`):

- Passwords, passphrases, PINs
- API keys, access/refresh tokens, private keys, client secrets
- Payment details (card numbers, CVV, IBAN, account/routing numbers)
- Government identifiers (SSN, passport, driver's licence, tax ID)
- Precise location (coordinates, home address)
- Sensitive medical or legal information (diagnoses, prescriptions, cases)
- Sensitive traits: political affiliation, religion, sexual orientation,
  gender identity, ethnicity, union membership
- Relationship-dependency signals (e.g. "you're all I have")

Because the preference allowlist only permits the bounded enum values in
section 1, there is no place for a sensitive trait or political profile to be
stored even if it were inferred.

## 4. Local vs cloud data behavior

| | Local (default) | Cloud (optional) |
| --- | --- | --- |
| Storage | `localStorage` keys `daemon_adaptive_profile`, `daemon_adaptive_evidence`, `daemon_strategy_scores` | `public.adaptive_profiles`, `public.adaptive_evidence` |
| Requires sign-in | No | Yes |
| Works offline | Yes | No |
| Access control | Your browser profile only | Row Level Security, owner-only for select/insert/update/delete via `auth.uid()` |
| Ownership | n/a | `user_id` is immutable after insert (trigger-enforced) |

The local path is a full fallback: when you are offline or signed out, Daemon
still adapts, still explains itself, and still lets you edit or erase
everything. No provider API keys ever exist in the frontend bundle — cloud
model calls happen only inside the `daemon-chat` edge function.

## 5. Consent, opt-out, and your controls

Everything is reachable from **Personality Preferences → What Daemon Learned**.

| Action | Effect |
| --- | --- |
| **Learning toggle** | Turning learning off stops all new inference immediately. Existing entries stay visible and manageable. |
| **Accept** | Converts an inferred value into a durable explicit confirmation. |
| **Edit** | Replaces the value with one you choose from the allowlist, stored as an explicit confirmation. |
| **Remove** | Deletes that preference and the evidence behind it. |
| **Reset learned data** | Deletes every inferred preference and all evidence. Explicit confirmations are kept. |
| **Export** | Downloads a JSON file with the full profile and evidence ledger. |

Every stored preference carries a plain-language `explanation`, a `source`
(`feedback-derived` or `explicit-user-confirmation`), a `confidence`, and an
`evidenceCount`, so nothing is hidden or unexplainable.

**Explicit settings always win.** If you set "Response detail: concise" in
Personality Preferences, that beats any inferred detail tendency —
`getEffectivePreference()` enforces this precedence.

## 6. Strategy selection

Approved strategies: `direct-answer`, `clarify-first`, `step-by-step-plan`,
`listen-first`, `tradeoff-options`, `research-and-cite`, `concise-action-plan`.

Selection order (`selectStrategy`):

1. The safety/approval allowlist for the `(intent, mood)` situation.
   Mood constraints override intent constraints.
2. Explicit personality settings, applied as filters that can never empty the
   approved set.
3. A trusted `preferred_problem_solving_strategy` (confidence > 0.7).
4. Deterministic exploration of an approved strategy with no feedback yet.
5. Highest Laplace-smoothed helpfulness score, **alphabetical on ties**.

### Safety boundary

The distress moods `sad`, `overwhelmed`, and `discouraged` are restricted to
supportive strategies (`listen-first`, `direct-answer`,
`concise-action-plan`). Humor-first handling is not selectable in those
contexts under any learned score, and Daemon's existing crisis handling is
untouched by this layer.

## 7. Memory provenance

Every retrieved item is tagged:

- `type: 'explicit'` — something you explicitly asked Daemon to remember;
  confidence `1`; receives a `+0.2` priority bonus over inferred context.
- `type: 'adaptive-preference'` — something Daemon inferred; carries its real
  confidence and an explanation of where it came from.

Retrieval is hard-bounded: at most **5 items** and **1000 characters** by
default, with a minimum relevance score of `0.1`. Recency adds `+0.1` for
items under 7 days old and `+0.05` under 30 days.

## 8. Capability routing and fallback

`routeRequest` (`src/services/daemonCapabilityRouter.ts`) is deterministic:

| Situation | Mode | Reason |
| --- | --- | --- |
| Privacy opt-out | `local` | `privacy-opt-out` |
| Offline | `local` | `offline` |
| Signed out | `local` | `unauthenticated` |
| Explicit user preference (available) | as chosen | `user-preference` |
| Complex reasoning, signed in, cloud configured | `cloud` | `complex-reasoning` |
| Needs live info or calculation tools | fallback | `capability-unavailable` |
| Everything else | `local` | `simple-chat` |

Research and tool modes are **not configured** in this build
(`RESEARCH_CAPABILITY_ENABLED = false`, `TOOL_CAPABILITY_ENABLED = false`).
When a request would need one, Daemon says so truthfully and falls back rather
than pretending it looked something up. `safeFallback` is always `local`,
which is why the assistant keeps working offline and signed out.

## 9. Evaluation

`src/services/daemonEvaluation.ts` provides:

- `computeLocalMetrics()` — content-free aggregates (feedback rates per intent,
  override count, memory-retrieval usage, strategy distribution, latency
  category, error count). Nothing leaves the device.
- `runEvaluationSuite()` — deterministic fixtures asserting intent/mood
  strategy selection, preference precedence, memory relevance and exclusion,
  safety boundaries, and routing decisions.

## 10. Future fine-tuning policy

If model fine-tuning is ever introduced:

- It will be **opt-in only**, never on by default, never retroactive.
- Data will be **curated and de-identified** before any training use.
- Prohibited categories (section 3) are excluded at collection time, so they
  cannot enter a training set.
- Users will be able to withdraw consent and have their contributions removed
  from future training runs.
- No user-specific model will be produced that could be used to profile or
  re-identify a person.
- Safety, crisis, refusal, and identity behavior will remain fixed policy —
  they will never be learned or fine-tuned away.
