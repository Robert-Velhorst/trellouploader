# Deployment target

## Hosting decision — 2026-10-24

Robert explicitly excluded this repository from the Hetzner portfolio hosting
plan. It does not need to run on General-Server. Do not provision a server
runtime, deployment subdomain, DNS record, TLS certificate or server deployment
key for this repository under the current plan.

Keep this repository in the security, quality and current stable-version audit.
This hosting exclusion does not disable needed local tooling or workflows and
does not authorize deleting existing data, backups or resources. If an existing
hosted service is found, report it and prepare its retirement separately.

## Any future hosting decision

Reconsider server deployment only after Robert explicitly changes this decision.
Hetzner Cloud remains the designated provider if production hosting is later
approved. Do not create new Vercel deployments or Ngrok public tunnels.

Before an approved future cutover, document the actual application role,
infrastructure, DNS/TLS, secrets, storage/database migration, security controls,
monitoring, backups and rollback. Preserve existing workloads and local tooling.
Do not claim migration or deployment until the running service and data path
have been verified. Keep credentials and private data out of this document.
