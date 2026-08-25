# GitHub issue write Edge Function

`github-write` is intentionally separate from `github-write-access`. It accepts
one explicitly confirmed, idempotent issue-creation request for a user-owned,
server-verified GitHub App repository connection.

It does not proxy arbitrary GitHub endpoints and cannot create files, pull
requests, comments, workflows, secrets, or repository configuration changes.
See [`../github-write-access/README.md`](../github-write-access/README.md) for
GitHub App setup, secrets, deployment, consent, revocation, and key rotation.
