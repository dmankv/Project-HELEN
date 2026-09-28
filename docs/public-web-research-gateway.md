# Daemon public-web research gateway (production-safe)

This capability is **not unrestricted internet access**. It is a constrained, server-side, read-only research path for Daemon that is fail-closed by default.

## Enforcement boundary

- Enforcement is server-side in Supabase Edge Functions.
- Browser code may request research, but cannot bypass server policy.
- Allowed outbound methods are only `GET` and `HEAD`.
- Destination credentials are never forwarded; request cookies/authorization are not passed through.

## Broad public web vs unrestricted network

- The policy supports broad public HTTPS destinations after central validation.
- This is still **not** unrestricted egress:
  - non-HTTPS schemes are blocked;
  - localhost/internal/private/metadata destinations are blocked;
  - unusual ports are blocked;
  - every redirect destination is revalidated;
  - DNS resolution is validated server-side before fetch.

## Threat model highlights

- SSRF protections include protocol, host, port, IP-range, DNS-result, and redirect checks.
- Untrusted content is treated as data only: sanitized/bounded text extraction, no active content execution.
- Research cannot mutate policy, auth/RLS, secrets, deployment, or production controls.
- Audit metadata is redacted; raw tokens/cookies/secrets are not logged.

## Classification and legal/safety policy

- High-risk categories are blocked (for example phishing/credential-harvesting, malware delivery, exploitative unlawful content).
- Uncertain high-risk classifications fail closed.
- Publisher restrictions are respected where available (for example `robots.txt` checks).
- `robots.txt` is treated as policy input, not security authorization.

## Learning and storage model

- Fetched source records store provenance (URL/host/timestamp/status/content type/size/hash/policy decision/excerpt).
- External learnings are stored as **quarantined unverified insights** with confidence, expiry, and evaluation state.
- Quarantined insights can support source-attributed summaries only.
- Automatic promotion to durable behavior is blocked pending deterministic validation + consent-controlled workflows.

## Provider/search prerequisites

- Discovery/search adapter is deny-by-default until explicit provider configuration is present.
- DNS pinning backend mode must be configured **and** the gateway must have a pinned transport implementation available; otherwise research stays fail-closed.
- Direct URL retrieval uses the same research policy gateway and remains disabled until that pinned transport exists.
- Search terms are derived only from explicit research requests, not private conversation history or secrets.

## Operational controls and incident response

- Immutable budgets constrain request count, bytes, response size, redirects, and runtime.
- Kill switch: set `DAEMON_PUBLIC_WEB_RESEARCH_MODE` away from `configured` to immediately disable the path.
- On incident:
  1. Disable research mode (kill switch).
  2. Review redacted `research_audit_events`.
  3. Review `research_fetch_provenance` and quarantined insight rows.
  4. Re-enable only after policy/config verification.
