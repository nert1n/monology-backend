# Deploy on Railway (MONOLOGY)

Two services + one Postgres plugin. Prefer **Bun** (lockfile + Dockerfiles use `oven/bun`).

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────┐
│  frontend       │────▶│  backend (API)   │────▶│  Postgres  │
│  Vite → static  │     │  NestJS + Prisma │     │  plugin    │
└─────────────────┘     └──────────────────┘     └────────────┘
```

## 1. Create a Railway project

1. [Railway](https://railway.app) → **New Project**.
2. Add a **PostgreSQL** plugin (Railway Postgres).
3. Create two empty services: **backend**, **frontend** (or deploy from GitHub).

Connect each service to its GitHub repo:

| Service    | Repo (example)              | Root directory |
|------------|-----------------------------|----------------|
| backend    | `nert1n/monology-backend`   | `/` (repo root)|
| frontend   | `nert1n/monology`           | `/` (repo root)|

If you later merge into a monorepo, set **Root Directory** to `backend` / `frontend`.

**Deploy order:** Postgres → backend (migrate + health) → frontend (needs API URL).

---

## 2. Backend service

### Build / start

`railway.toml` + `Dockerfile` (Bun):

- **Build:** Docker image (`oven/bun`), `prisma generate` + `nest build`
- **Release:** `bunx prisma migrate deploy`
- **Start:** `bun run start:prod` (`bun dist/main.js`)
- **Healthcheck:** `GET /api/health`

### Environment variables (Railway Variables tab)

Postgres does **not** auto-inject `DATABASE_URL` into the backend. On the **backend** service → **Variables**, add a **reference** (or paste the template string). The Postgres service name in `${{…}}` is case-sensitive and must match the plugin name in the project (often `Postgres` or `PostgreSQL`).

#### Copy-paste checklist (backend)

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | *(long random string you generate; not committed)* |
| `CORS_ORIGIN` | `https://monology.vercel.app` *(scheme required; no trailing slash; comma-separated OK)* |
| `NODE_ENV` | `production` *(optional but recommended)* |

CLI equivalent (quote so the shell does not expand `${{…}}`):

```bash
railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --service backend
railway variables --set 'JWT_SECRET=<your-long-random-secret>' --service backend
railway variables --set 'CORS_ORIGIN=https://monology.vercel.app' --service backend
```

If your DB service is named `PostgreSQL`, use `${{PostgreSQL.DATABASE_URL}}` instead.

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | yes | From Postgres plugin via reference above |
| `JWT_SECRET` | yes | Long random string |
| `JWT_EXPIRES_IN` | no | Default `7d` |
| `CORS_ORIGIN` | yes (prod) | Frontend origin with scheme, e.g. `https://monology.vercel.app` (comma-separated OK). **Not** bare `monology.vercel.app` — browsers send `https://…` and reject a scheme-less ACAO. |
| `PORT` | no | Railway sets this automatically |
| `NODE_ENV` | no | `production` |
| `API_PREFIX` | no | Default `api` |
| `ADMIN_EMAIL` | no | That email becomes `ADMIN` on register |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Real Google OAuth when both set |
| `GOOGLE_CALLBACK_URL` | no | `https://<api-host>/api/auth/google/callback` |
| `GOOGLE_FRONTEND_REDIRECT` | no | Defaults to `CORS_ORIGIN/settings/profile` |
| `OMDB_API_KEY` / `TMDB_API_KEY` | no | Catalog enrich scripts |

Copy the checklist from [`.env.example`](./.env.example).

**Startup crash `DATABASE_URL` / `JWT_SECRET` `isString`:** those vars are missing or empty on this service. Set them on Variables and redeploy — validation now prints the same hints in the deploy log.

### Uploads volume (avatars / covers)

The API stores files under `./uploads` (Docker/Railway: `/app/uploads`). Attach a **Railway Volume** mounted at **`/app/uploads`** on the backend service so files survive redeploys.

Optional env: `UPLOADS_DIR=/app/uploads` (defaults to `{cwd}/uploads`).

**Sync local media only** (not the DB): see [scripts/sync-uploads-to-railway.md](./scripts/sync-uploads-to-railway.md).

```bash
bun run sync:uploads              # print inventory + exact railway commands
railway ssh --service monology-backend -- echo ok   # if Timeout → VPN/DNS
bun run sync:uploads:upload       # after railway login + link (SFTP)
# SFTP Timeout → CDN covers (no 1GB) then SSH pipe for small dirs:
#   bun run rewrite:shiki-covers-cdn --apply
#   bun run sync:uploads:ssh-pipe -- --only avatars,backgrounds
```

After `volume add`, wait until backend redeploy is Online before SFTP. Details: sync doc §0c.

### Verify

```bash
curl -s https://<api-host>/api/health
# {"status":"ok", ...}
```

---

## 3. Frontend service

### Build / start

Frontend `Dockerfile` / `railway.toml`:

- **Build args / env (build-time):** `VITE_API_BASE_URL`, `VITE_MEDIA_ORIGIN`
- **Start:** static SPA via `serve -s dist`

### Environment variables

| Variable | Required | Example |
|----------|----------|---------|
| `VITE_API_BASE_URL` | yes | `https://monology-backend-production.up.railway.app/api` |
| `VITE_MEDIA_ORIGIN` | yes (prod) | `https://monology-backend-production.up.railway.app` (no `/api`) |
| `PORT` | no | Railway sets this |

Set these as **build** variables on Railway so Vite inlines them into the bundle.

### Vercel frontend

If the SPA is on Vercel (`https://monology.vercel.app`), set the same two `VITE_*` vars in the Vercel project (Production), then redeploy. Do **not** leave `VITE_API_BASE_URL=/api` — that calls Vercel, not this API. Details: frontend `DEPLOY.md`.

### CORS

Backend `CORS_ORIGIN` must match the frontend origin (scheme + host, no trailing slash), e.g. `https://monology.vercel.app`.

---

## 4. Database notes (Postgres)

Prisma targets **PostgreSQL** (Railway-friendly). SQLite migrations are archived under `prisma/migrations_sqlite_archive/` for history only.

### Local Postgres

```bash
docker compose up -d
cp .env.example .env   # DATABASE_URL already points at local compose
bun install
bunx prisma migrate deploy   # or: bun run prisma:migrate
bun run start:dev
```

### Fresh Railway DB

`releaseCommand` runs `prisma migrate deploy` on each deploy — no manual migrate needed after the first successful release.

### Migrate local SQLite data → Railway Postgres

Local data currently lives in **`prisma/dev.db`** (SQLite; see `.env` `file:./dev.db`). Schema on Railway is already Postgres — you only need to copy **rows** (+ `uploads/` files).

Full Russian step-by-step: [`scripts/migrate-local-to-railway.md`](./scripts/migrate-local-to-railway.md).

Safe defaults (dry-run / export only):

```bash
# 1) Export local SQLite → tmp/sqlite-export.json (no prod writes)
bun run db:export-sqlite

# 2) Inspect plan against Railway URL (still no writes without --apply)
TARGET_DATABASE_URL='postgresql://…from Railway…' \
  bun run db:migrate-to-postgres -- --from-export tmp/sqlite-export.json

# 3) YOU run import (wipe = replace all app tables; omit --wipe to merge by id)
TARGET_DATABASE_URL='postgresql://…' \
  bun run db:migrate-to-postgres -- --from-export tmp/sqlite-export.json --apply --wipe
```

**Warnings:** `--wipe` truncates production tables; copy `uploads/` to the Railway volume separately; never commit DB dumps (password hashes). Use the **Public** Railway URL (`*.proxy.rlwy.net` + `?sslmode=require`) from a laptop — see troubleshooting in [migrate-local-to-railway.md](./scripts/migrate-local-to-railway.md) if `Can't reach database server` (often ISP DNS). If credentials were exposed, rotate `POSTGRES_PASSWORD` in Railway.

---

## 5. Optional: Nixpacks without Docker

If you switch the service builder to Nixpacks/Railpack, `nixpacks.toml` is provided. Prefer the Dockerfile for reproducible Bun + Prisma builds.

---

## 6. Checklist

- [ ] Postgres plugin in the same Railway project
- [ ] Backend Variables: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (or `PostgreSQL` if that is the service name)
- [ ] Backend Variables: `JWT_SECRET` set (not the example value)
- [ ] Backend Variables: `CORS_ORIGIN=https://monology.vercel.app` (or your frontend URL, with `https://`)
- [ ] Backend deploys; `/api/health` returns `ok`
- [ ] Volume mounted at `/app/uploads` (if you need persistent media)
- [ ] (Optional) Local SQLite data migrated — see [migrate-local-to-railway.md](./scripts/migrate-local-to-railway.md)
- [ ] Frontend `VITE_API_BASE_URL` + `VITE_MEDIA_ORIGIN` set at **build** time (Vercel and/or Railway)
- [ ] (Optional) Google OAuth callback URLs updated for production hosts
