# Supabase project secret write Edge Function

This function is intentionally separate from
`supabase-project-access`. It accepts a secret value only for a single,
explicitly confirmed write request using a separately consented
`write_secrets` OAuth connection.

It does not list secrets, read response bodies, return secret values, log
values, or store values. See the deployment and consent requirements in
[`../supabase-project-access/README.md`](../supabase-project-access/README.md).
