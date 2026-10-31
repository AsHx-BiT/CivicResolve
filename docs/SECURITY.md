# Security notes

## Current application controls

- Passwords are scrypt hashes; random opaque session tokens are stored as SHA-256 hashes in PostgreSQL. Sessions expire and logout revokes them.
- Session cookies are `HttpOnly` and `SameSite=Strict`. `Secure` is forced when `NODE_ENV=production` and configurable locally with `COOKIE_SECURE`.
- Cookie-authenticated mutations require a CSRF token and allowed `Origin`. Helmet, JSON body size limits, login throttling and configurable API rate limits are enabled.
- The local `.env.example` uses a 3,000-request / 15-minute API limit to accommodate development reloads and demo use. Production defaults to 300 / 15 minutes when `API_RATE_LIMIT_MAX` is unset; the login and registration endpoints retain separate stricter limits. Set and validate production limits for the deployed proxy and expected traffic.
- Zod schemas reject unknown fields on core writes. Tenant IDs are taken from the authenticated session, and related IDs are checked within that tenant. Case visibility additionally applies citizen, department or assignment scope. Report, attachment and configuration routes have authorization checks.
- Uploads are limited to five files and 10 MiB each, allow PDF/JPEG/PNG, and validate their byte signatures against the declared media type. Downloads require access to the attachment's case. Local files are stored beneath `backend`'s current working directory `storage/uploads`.
- Audit entries are written for sensitive case/configuration actions. A PostgreSQL trigger makes audit rows append-only.
- The seed refuses to run with `NODE_ENV=production`, hashes development passwords and never writes plaintext passwords to the database.

## Required before any production deployment

This project has **not** been independently security-audited and is not asserted production-ready. The following controls are not implemented or independently verified here:

- Replace all demo accounts/passwords and Compose credentials; provide a managed secret source and rotate database/session signing secrets where applicable. Never deploy `.env.example` defaults or a seeded database.
- Use TLS end-to-end, production CORS allowlists, secure cookie settings, reverse-proxy trust settings, request-size/rate-limit tuning and production-safe error/logging policies.
- Move attachments to private object storage with malware scanning, retention/deletion policy, encryption, backup and restore testing. Local disk is suitable only for a single-host demo.
- Add tested backup/restore and disaster recovery, monitoring/alerting, structured log retention, migration rollback procedures, deployment/CI controls and operational ownership for scheduler uptime.
- Perform independent threat modeling and security review, dependency and container image scanning, penetration testing, and privacy/legal review for municipal resident data.
- Review access policy for every organization and role. Seeded access is a demonstration policy, not an approved municipal authorization model.

## Seed account warning

The seven demo accounts and all case data are development-only. On first seed, a generated shared password is printed once; alternatively configure a random local `SEED_PASSWORD` of at least 16 characters before seeding. Do not paste a production credential into `.env`, commit `.env`, or use any demo credential in a deployed service. Re-seeding without `SEED_PASSWORD` does not replace existing hashes; setting it in a local `.env` intentionally changes seeded account passwords.

## Current file limitations

Citizen self-registration is limited to the Citizen role and is rate limited, but email ownership verification and bot protection are not connected in this local demo. Add verified contact flows and abuse controls before exposing registration publicly.

Signature checks only establish that a file begins with the expected basic format marker. They are not full parsing, malware detection or content sanitization. Download responses are attachment-only with `nosniff`, and storage paths are generated server-side, but production file storage and scanning controls remain necessary.
