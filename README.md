# Backend — MONOLOGY

NestJS API with Prisma (PostgreSQL) and JWT auth.

## Structure

```
src/
  auth/         # register, login, me
  users/        # public profile, PATCH me
  categories/   # public + owner CRUD
  items/        # owner CRUD
  prisma/       # PrismaService
  config/       # env
  common/       # filters, DTOs
  health/
```

## Setup

```bash
docker compose up -d          # local Postgres
cp .env.example .env
bun install
bunx prisma migrate dev
bun run start:dev
```

Production / Railway: see [DEPLOY.md](./DEPLOY.md).

## Main endpoints

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/register` | no |
| POST | `/api/auth/login` | no |
| GET | `/api/auth/me` | yes |
| GET | `/api/users/:username` | no |
| PATCH | `/api/users/me` | yes |
| GET | `/api/users/:username/categories` | no |
| GET | `/api/users/:username/categories/:slug` | no |
| POST/PATCH/DELETE | `/api/categories` … | yes |
| POST/PATCH/DELETE | `/api/items` … | yes |
| GET | `/api/health` | no |

See root [`README.md`](../README.md) and [`AGENTS.md`](../AGENTS.md).

## Catalog imports

| Script | Source | Media type |
|--------|--------|------------|
| `bun run import:shikimori-anime` | Shikimori API | ANIME |
| `bun run import:shikimori-anime-2026` | Shikimori API (`season=2026`) | ANIME |
| `bun run import:shikimori-movies` / `import:shikimori-serials` | Shikimori (anime film / TV) | MOVIE / SERIAL |
| `bun run import:imdb-movies` | [IMDb non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) | MOVIE |
| `bun run import:nert1n-animes` | local JSON + Shikimori | ANIME (+ shelf items) |

### IMDb movies

Downloads `title.basics` + `title.ratings` from `datasets.imdbws.com` (cached under `scripts/.cache/imdb/`).

Defaults: `titleType=movie`, non-adult, has year, `numVotes ≥ 10000`, ordered by votes. Safe to re-run (dedupes on title+year+MOVIE).

```bash
# Sample / smoke
bun run import:imdb-movies -- --limit 50

# Broader popular set
bun run import:imdb-movies -- --min-votes 10000

# Optional posters (set OMDB_API_KEY and/or TMDB_API_KEY in .env)
bun run import:imdb-movies -- --limit 100
```
