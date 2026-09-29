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
  - DNS answers are checked before connecting; the selected public IP is used for the TCP connection, while the original hostname is used for TLS SNI, certificate verification, and the HTTP Host header.

## Threat model highlights

- SSRF protections include protocol, host, port, IP-range, DNS-result, and redirect checks.
- Untrusted content is treated as data only: sanitized/bounded text extraction, no active content execution.
- Research cannot mutate policy, auth/RLS, secrets, deployment, or production controls.
- Audit metadata is redacted; raw tokens/cookies/secrets are not logged.

## Classification and legal/safety policy

- High-risk categories are blocked (for example phishing/credential-harvesting, malware delivery, exploitative unlawful content).
- Uncertain high-risk classifications fail closed.
- Publisher restrictions are respected: `robots.txt` is fetched over the same pinned transport before each source request. Only a successful robots response or a 404/410 permits proceeding; redirects, malformed responses, and failures block the request.
- `robots.txt` is treated as policy input, not security authorization.

## Learning and storage model

- Fetched source records store provenance (URL/host/timestamp/status/content type/size/hash/policy decision/excerpt).
- External learnings are stored as **quarantined unverified insights** with confidence, expiry, and evaluation state.
- Quarantined insights can support source-attributed summaries only.
- Automatic promotion to durable behavior is blocked pending deterministic validation + consent-controlled workflows.

## Provider/search prerequisites

- Discovery/search adapter is deny-by-default until explicit provider configuration is present.
- Set both `DAEMON_PUBLIC_WEB_RESEARCH_MODE=configured` and `DAEMON_RESEARCH_DNS_PINNING_MODE=configured` to enable direct-URL retrieval; all other values fail closed.
- The transport uses `Deno.connect` to the checked IP and `Deno.startTls` with the original hostname. It implements bounded HTTP/1.1 response framing (including chunked bodies) with explicit TLS handshake, no automatic redirects, and no fallback to unpinned `fetch`. It does not disable certificate checks.
- Confirm on the **actual hosted Supabase Edge deployment** that outbound TCP/443 and `Deno.startTls` work, a valid certificate succeeds, a hostname mismatch fails, and deadlines close the connection before enabling the two settings. Source-level runtime support does not establish that every deployment permits direct TCP.
- Search-query discovery remains fail-closed; `DAEMON_RESEARCH_SEARCH_ENDPOINT`/`DAEMON_RESEARCH_SEARCH_API_KEY` do not enable an unvetted search adapter. Supply explicit public URLs for now.
- Search terms are derived only from explicit research requests, not private conversation history or secrets.

## Operational controls and incident response

- Immutable budgets constrain request count (including robots requests), bytes (including robots bodies), response size, redirects, and runtime. Each redirect repeats URL, DNS, and robots validation.
- Source bytes are never supplied as model instructions. Only sanitized, source-attributed excerpts are returned; optional stored insights start in `quarantined` / `blocked_pending_validation` with an expiry and cannot automatically promote to durable behavior.
- Kill switch: set `DAEMON_PUBLIC_WEB_RESEARCH_MODE` away from `configured` to immediately disable the path.
- On incident:
  1. Disable research mode (kill switch).
  2. Review redacted `research_audit_events`.
  3. Review `research_fetch_provenance` and quarantined insight rows.
  4. Re-enable only after policy/config verification.
