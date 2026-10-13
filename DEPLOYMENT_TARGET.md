

# Deployment target

Hetzner is the target for production deployment. New production deployments must be prepared for Hetzner. Existing Vercel or ngrok production use must be inventoried and migrated to Hetzner before being retired; do not claim a migration or cutover until the running service, data, secrets, security controls, backups, and rollback path have been verified.

Preserve local development and test tooling when it is still needed, but do not use Vercel or ngrok for new production deployments. Document the Hetzner architecture, required infrastructure, deployment steps, data and database migration, DNS/TLS, secrets, monitoring, backups, and rollback in the project deployment guide before cutover. Keep credentials and private data out of this file.