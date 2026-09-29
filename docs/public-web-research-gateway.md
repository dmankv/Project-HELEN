# Daemon public-web research gateway (production-safe)

This capability is **not unrestricted internet access**. It is a constrained, server-side, read-only research path for Daemon that is fail-closed by default.

## Enforcement boundary

- Enforcement is server-side in Supabase Edge Functions.
- Browser code may request research, but cannot bypass server policy.
- Allowed outbound methods are only `GET` and `HEAD`.
- Destination credentials are never forwarded; request cookies/authorization are not passed through.
- Active retrieval modes are direct-URL requests and bounded autonomous retrieval during the current authenticated interactive turn.
- Autonomous retrieval follows at most one eligible public HTTPS URL explicitly present in the current user message. It never derives a URL from memories, hidden context, prior turns, or model output.
- There is no background crawling, polling, queued research, or autonomous retry.

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
- Direct requests may opt into storing external learnings as **quarantined unverified insights** with confidence, expiry, and evaluation state.
- Autonomous current-turn requests always send `store_insight: false`; their excerpts are visibly labeled untrusted/quarantined and are never passed to the durable-learning acceptance path.
- Quarantined insights can support source-attributed summaries only.
- Automatic promotion to durable behavior is blocked pending deterministic validation + consent-controlled workflows.

## Provider/search prerequisites

- Search-query discovery is disabled until a separate vetted, pinned search adapter is implemented.
- Set both `DAEMON_PUBLIC_WEB_RESEARCH_MODE=configured` and `DAEMON_RESEARCH_DNS_PINNING_MODE=configured` to enable direct-URL retrieval; all other values fail closed.
- The transport uses `Deno.connect` to the checked IP and `Deno.startTls` with the original hostname. It implements bounded HTTP/1.1 response framing (including chunked bodies) with explicit TLS handshake, no automatic redirects, and no fallback to unpinned `fetch`. It does not disable certificate checks.
- Confirm on the **actual hosted Supabase Edge deployment** that outbound TCP/443 and `Deno.startTls` work, a valid certificate succeeds, a hostname mismatch fails, and deadlines close the connection before enabling the two settings. Source-level runtime support does not establish that every deployment permits direct TCP.
- `DAEMON_RESEARCH_SEARCH_ENDPOINT`/`DAEMON_RESEARCH_SEARCH_API_KEY` do not enable an unvetted search adapter. Supply an explicit public HTTPS URL in the current message.

## Operational controls and incident response

- One overall abortable deadline covers rate-limit storage, audit writes, DNS A/AAAA requests, socket/TLS I/O, robots retrieval, redirects, source retrieval, hashing, and provenance/quarantine writes. DNS never applies a timeout floor beyond the remaining budget, and deadline expiry aborts DNS and closes active sockets.
- Immutable budgets constrain request count (including robots requests), bytes (including robots bodies), response size, redirects, and runtime. Each redirect repeats URL, DNS, and robots validation without resetting the overall deadline.
- Research-specific rate-limit storage failures return a safe service-unavailable response before DNS or target-host transport begins. Normal chat retains its documented fail-open behavior during a rate-limit storage outage.
- Source bytes are never supplied as model instructions. Only sanitized, source-attributed excerpts are returned; optional stored insights start in `quarantined` / `blocked_pending_validation` with an expiry and cannot automatically promote to durable behavior.
- Kill switch: set `DAEMON_PUBLIC_WEB_RESEARCH_MODE` away from `configured` to immediately disable the path.
- On incident:
  1. Disable research mode (kill switch).
  2. Review redacted `research_audit_events`.
  3. Review `research_fetch_provenance` and quarantined insight rows.
  4. Re-enable only after policy/config verification.
