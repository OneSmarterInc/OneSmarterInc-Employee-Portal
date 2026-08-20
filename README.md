# One Smarter Inc. Employee Portal

Internal employee and manager portal built for Vercel.

## Stack

- React.js + Vite
- Vercel Functions (Node.js)
- PostgreSQL / Neon through Vercel Marketplace
- Vercel Blob private storage for letters, documents and policies
- Cookie-based authenticated sessions

## Included workflows

- Manager and employee accounts
- Employee directory and status management
- Per-employee Work From Home entitlement
- Attendance check-in / check-out with Office or WFH mode
- Leave balances, applications, approvals/rejections and team planner
- Company policies and acknowledgement tracking
- Employee-specific offer, appointment, increment, experience and relieving letters
- Employee resignation, manager approval/rejection and clearance tracking
- Manager-configured SMTP with encrypted stored password
- In-app notifications, login events and manager audit trail

## Local setup

```bash
npm install
cp .env.example .env.local
npm run db:setup
npm run dev
```

Set `POSTGRES_URL`, `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `BOOTSTRAP_MANAGER_EMAIL`, `BOOTSTRAP_MANAGER_PASSWORD` and `BLOB_READ_WRITE_TOKEN` before setup.

## Vercel setup

1. Import this GitHub repository into Vercel.
2. Add a Neon/Postgres integration and expose `POSTGRES_URL`.
3. Add Vercel Blob and expose `BLOB_READ_WRITE_TOKEN`.
4. Add `AUTH_SECRET` and `APP_ENCRYPTION_KEY` as production secrets.
5. Add temporary bootstrap manager variables, run `npm run db:setup` against the production database, then rotate/remove the bootstrap password variable.
6. Deploy from `main` after review.

`npm run build` verifies the React production build.

## Upload note

Server-side document uploads are limited to 3 MB per file so the base64 payload stays within the Vercel Function request limit.
