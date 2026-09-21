/**
 * Migrate local SQLite (prisma/dev.db) → PostgreSQL (Railway / local Docker).
 *
 * Default is dry-run (no writes). Pass --apply to import.
 *
 * Usage (from backend/):
 *   # Plan only (safe)
 *   bun run scripts/migrate-sqlite-to-postgres.ts
 *
 *   # Export JSON dump (no Postgres needed)
 *   bun run scripts/migrate-sqlite-to-postgres.ts --export-only
 *
 *   # Import dump into Railway (schema must already be migrated)
 *   TARGET_DATABASE_URL='postgresql://…' \
 *     bun run scripts/migrate-sqlite-to-postgres.ts --from-export tmp/sqlite-export.json --apply
 *
 *   # Wipe Railway tables then import (DESTRUCTIVE)
 *   TARGET_DATABASE_URL='postgresql://…' \
 *     bun run scripts/migrate-sqlite-to-postgres.ts --from-export tmp/sqlite-export.json --apply --wipe
 *
 *   # Direct SQLite → Postgres (merge / upsert by id)
 *   TARGET_DATABASE_URL='postgresql://…' \
 *     bun run scripts/migrate-sqlite-to-postgres.ts --apply
 *
 * Never commit dumps (contain password hashes). uploads/ must be copied separately.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { config as loadEnv } from 'dotenv';
import { Prisma, PrismaClient } from '../generated/prisma/index.js';

const BACKEND_ROOT = path.resolve(import.meta.dirname, '..');
loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const DEFAULT_SQLITE = path.join(BACKEND_ROOT, 'prisma', 'dev.db');
const DEFAULT_EXPORT = path.join(BACKEND_ROOT, 'tmp', 'sqlite-export.json');
const BATCH = 500;

/** Insert order: parents before children. */
const TABLES = [
  'User',
  'Achievement',
  'Genre',
  'Media',
  'Category',
  'Friendship',
  'Club',
  'ClubMember',
  'ProfileComment',
  'UserAchievement',
  'MediaGenre',
  'MediaPhoto',
  'Item',
] as const;

type TableName = (typeof TABLES)[number];

type Dump = {
  exportedAt: string;
  source: string;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
};

type CliOptions = {
  sqlitePath: string;
  exportPath: string;
  fromExport: string | null;
  exportOnly: boolean;
  apply: boolean;
  wipe: boolean;
  targetUrl: string | null;
  help: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    sqlitePath: process.env.SQLITE_PATH ?? DEFAULT_SQLITE,
    exportPath: DEFAULT_EXPORT,
    fromExport: null,
    exportOnly: false,
    apply: false,
    wipe: false,
    targetUrl: process.env.TARGET_DATABASE_URL ?? null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sqlite') opts.sqlitePath = argv[++i] ?? opts.sqlitePath;
    else if (arg === '--export') opts.exportPath = argv[++i] ?? opts.exportPath;
    else if (arg === '--from-export') opts.fromExport = argv[++i] ?? null;
    else if (arg === '--export-only') opts.exportOnly = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--wipe') opts.wipe = true;
    else if (arg === '--target-url') opts.targetUrl = argv[++i] ?? opts.targetUrl;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function printHelp(): void {
  console.log(`Migrate SQLite → Postgres (dry-run by default).

  --sqlite <path>         Source SQLite file (default: prisma/dev.db)
  --export <path>         Where to write JSON dump (default: tmp/sqlite-export.json)
  --export-only           Only dump SQLite → JSON, then exit
  --from-export <path>    Import from JSON instead of reading SQLite
  --target-url <url>      Postgres URL (or set TARGET_DATABASE_URL)
  --apply                 Write to Postgres (required for import)
  --wipe                  TRUNCATE all app tables before import (needs --apply)
  --help

Safety: without --apply nothing is written to Postgres.
Do not commit JSON dumps. Copy uploads/ to Railway volume separately.
Railway public URLs (*.rlwy.net) get ?sslmode=require appended automatically.
`);
}

function toDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'bigint') return new Date(Number(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return new Date(Number(trimmed));
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value as Prisma.InputJsonValue;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Prisma.InputJsonValue;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function readSqliteDump(sqlitePath: string): Dump {
  const db = new Database(sqlitePath, { readonly: true });
  const tables: Dump['tables'] = {};
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    const rows = db.query(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<
      string,
      unknown
    >[];
    tables[table] = rows;
    counts[table] = rows.length;
  }

  db.close();
  return {
    exportedAt: new Date().toISOString(),
    source: sqlitePath,
    counts,
    tables,
  };
}

async function loadDump(opts: CliOptions): Promise<Dump> {
  if (opts.fromExport) {
    const raw = await readFile(opts.fromExport, 'utf8');
    return JSON.parse(raw) as Dump;
  }
  return readSqliteDump(opts.sqlitePath);
}

async function writeDump(dump: Dump, exportPath: string): Promise<void> {
  await mkdir(path.dirname(exportPath), { recursive: true });
  await writeFile(exportPath, JSON.stringify(dump), 'utf8');
  console.log(`Wrote dump → ${exportPath}`);
}

/**
 * Railway public TCP proxies (*.proxy.rlwy.net / *.rlwy.net) require TLS.
 * Append sslmode=require when missing so Prisma/pg can negotiate SSL.
 * Internal hostnames (*.railway.internal) are left unchanged.
 */
function ensureRailwaySsl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const host = parsed.hostname.toLowerCase();
  const isRailwayProxy =
    host.endsWith('.rlwy.net') ||
    host.endsWith('.railway.app') ||
    host.includes('proxy.rlwy.net');

  if (!isRailwayProxy) return url;
  if (!parsed.searchParams.has('sslmode')) {
    parsed.searchParams.set('sslmode', 'require');
  }
  return parsed.toString();
}

function resolveTargetUrl(opts: CliOptions): string {
  const candidates = [
    opts.targetUrl,
    process.env.TARGET_DATABASE_URL,
    process.env.DATABASE_URL,
  ].filter(Boolean) as string[];

  for (const url of candidates) {
    if (url.startsWith('file:')) continue;
    if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
      return ensureRailwaySsl(url);
    }
  }

  throw new Error(
    'Need a Postgres TARGET_DATABASE_URL (or --target-url). ' +
      'Local .env still points at SQLite — do not reuse it as the target.',
  );
}

function normalizeUser(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    passwordHash: String(row.passwordHash),
    displayName: String(row.displayName),
    bio: row.bio == null ? '' : String(row.bio),
    avatarUrl: row.avatarUrl == null ? null : String(row.avatarUrl),
    profileBackgroundUrl:
      row.profileBackgroundUrl == null ? null : String(row.profileBackgroundUrl),
    profileHidden: toBool(row.profileHidden),
    profileColors: toJson(row.profileColors) ?? Prisma.JsonNull,
    websiteUrl: row.websiteUrl == null ? null : String(row.websiteUrl),
    sex: String(row.sex ?? 'PREFER_NOT_TO_SAY') as never,
    dateOfBirth: toDate(row.dateOfBirth),
    displayAge: toBool(row.displayAge),
    displayAdultContent: toBool(row.displayAdultContent),
    interfaceLanguage: String(row.interfaceLanguage ?? 'en') as never,
    googleId: row.googleId == null ? null : String(row.googleId),
    googleConnectedAt: toDate(row.googleConnectedAt),
    role: String(row.role ?? 'USER') as never,
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

function normalizeAchievement(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    code: String(row.code),
    title: String(row.title),
    description: row.description == null ? '' : String(row.description),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

function normalizeGenre(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

function normalizeMedia(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    type: String(row.type) as never,
    title: String(row.title),
    description: row.description == null ? '' : String(row.description),
    year: row.year == null ? null : Number(row.year),
    coverUrl: row.coverUrl == null ? null : String(row.coverUrl),
    status: row.status == null ? null : (String(row.status) as never),
    episodeCount: row.episodeCount == null ? null : Number(row.episodeCount),
    episodesAired: row.episodesAired == null ? null : Number(row.episodesAired),
    contentRating:
      row.contentRating == null ? null : (String(row.contentRating) as never),
    isAdult: toBool(row.isAdult),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

function normalizeCategory(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    userId: String(row.userId),
    name: String(row.name),
    slug: String(row.slug),
    kind: String(row.kind) as never,
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

function normalizeFriendship(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    requesterId: String(row.requesterId),
    addresseeId: String(row.addresseeId),
    status: String(row.status ?? 'PENDING') as never,
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

function normalizeClub(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description == null ? '' : String(row.description),
    coverUrl: row.coverUrl == null ? null : String(row.coverUrl),
    ownerId: String(row.ownerId),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

function normalizeClubMember(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    clubId: String(row.clubId),
    userId: String(row.userId),
    role: String(row.role ?? 'MEMBER') as never,
    joinedAt: toDate(row.joinedAt) ?? new Date(),
  };
}

function normalizeProfileComment(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    profileUserId: String(row.profileUserId),
    authorId: String(row.authorId),
    body: String(row.body),
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

function normalizeUserAchievement(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    userId: String(row.userId),
    achievementId: String(row.achievementId),
    unlockedAt: toDate(row.unlockedAt) ?? new Date(),
  };
}

function normalizeMediaGenre(row: Record<string, unknown>) {
  return {
    mediaId: String(row.mediaId),
    genreId: String(row.genreId),
  };
}

function normalizeMediaPhoto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    mediaId: String(row.mediaId),
    url: String(row.url),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

function normalizeItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    categoryId: String(row.categoryId),
    mediaId: row.mediaId == null ? null : String(row.mediaId),
    title: String(row.title),
    status: String(row.status ?? 'PLANNED') as never,
    rating: row.rating == null ? null : Number(row.rating),
    notes: row.notes == null ? '' : String(row.notes),
    year: row.year == null ? null : Number(row.year),
    completedAt: toDate(row.completedAt),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

async function createManyBatched<T>(
  label: string,
  rows: T[],
  insert: (batch: T[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = await insert(batch);
    total += result.count;
    if (rows.length > BATCH) {
      console.log(`  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
  }
  return total;
}

async function wipeTarget(prisma: PrismaClient): Promise<void> {
  const ordered = [...TABLES].reverse().map(quoteIdent).join(', ');
  console.log('Wiping target tables (TRUNCATE … CASCADE)…');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${ordered} RESTART IDENTITY CASCADE`);
}

async function importDump(prisma: PrismaClient, dump: Dump, wipe: boolean): Promise<void> {
  if (wipe) await wipeTarget(prisma);

  const t = dump.tables;

  const inserted: Record<string, number> = {};

  inserted.User = await createManyBatched('User', (t.User ?? []).map(normalizeUser), (batch) =>
    prisma.user.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Achievement = await createManyBatched(
    'Achievement',
    (t.Achievement ?? []).map(normalizeAchievement),
    (batch) => prisma.achievement.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Genre = await createManyBatched(
    'Genre',
    (t.Genre ?? []).map(normalizeGenre),
    (batch) => prisma.genre.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Media = await createManyBatched(
    'Media',
    (t.Media ?? []).map(normalizeMedia),
    (batch) => prisma.media.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Category = await createManyBatched(
    'Category',
    (t.Category ?? []).map(normalizeCategory),
    (batch) => prisma.category.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Friendship = await createManyBatched(
    'Friendship',
    (t.Friendship ?? []).map(normalizeFriendship),
    (batch) => prisma.friendship.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Club = await createManyBatched('Club', (t.Club ?? []).map(normalizeClub), (batch) =>
    prisma.club.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.ClubMember = await createManyBatched(
    'ClubMember',
    (t.ClubMember ?? []).map(normalizeClubMember),
    (batch) => prisma.clubMember.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.ProfileComment = await createManyBatched(
    'ProfileComment',
    (t.ProfileComment ?? []).map(normalizeProfileComment),
    (batch) => prisma.profileComment.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.UserAchievement = await createManyBatched(
    'UserAchievement',
    (t.UserAchievement ?? []).map(normalizeUserAchievement),
    (batch) => prisma.userAchievement.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.MediaGenre = await createManyBatched(
    'MediaGenre',
    (t.MediaGenre ?? []).map(normalizeMediaGenre),
    (batch) => prisma.mediaGenre.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.MediaPhoto = await createManyBatched(
    'MediaPhoto',
    (t.MediaPhoto ?? []).map(normalizeMediaPhoto),
    (batch) => prisma.mediaPhoto.createMany({ data: batch, skipDuplicates: true }),
  );
  inserted.Item = await createManyBatched('Item', (t.Item ?? []).map(normalizeItem), (batch) =>
    prisma.item.createMany({ data: batch, skipDuplicates: true }),
  );

  console.log('\nInserted (skipDuplicates — already-present rows skipped):');
  for (const name of TABLES) {
    const src = dump.counts[name] ?? t[name]?.length ?? 0;
    console.log(`  ${name}: ${inserted[name] ?? 0} new / ${src} source`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.wipe && !opts.apply) {
    throw new Error('--wipe requires --apply (refusing destructive dry-run confusion)');
  }

  console.log('Loading source…');
  const dump = await loadDump(opts);
  console.log(`Source: ${dump.source}`);
  console.log(`Exported at: ${dump.exportedAt}`);
  console.log('Row counts:');
  for (const name of TABLES) {
    console.log(`  ${name}: ${dump.counts[name] ?? dump.tables[name]?.length ?? 0}`);
  }

  if (!opts.fromExport) {
    await writeDump(dump, opts.exportPath);
  }

  if (opts.exportOnly) {
    console.log('\nExport-only mode — done. No Postgres connection.');
    return;
  }

  if (!opts.apply) {
    console.log(`
DRY-RUN — nothing written to Postgres.
Next:
  1. Ensure Railway schema is migrated (deploy backend / prisma migrate deploy).
  2. Copy uploads/ to the Railway volume separately (~1GB+ of media files).
  3. Import with wipe (fresh prod) or merge:

     TARGET_DATABASE_URL='postgresql://…from Railway…' \\
       bun run scripts/migrate-sqlite-to-postgres.ts \\
         --from-export ${opts.exportPath} --apply --wipe

     # or merge without wipe (skipDuplicates by primary key):
     TARGET_DATABASE_URL='…' bun run scripts/migrate-sqlite-to-postgres.ts \\
         --from-export ${opts.exportPath} --apply
`);
    return;
  }

  const targetUrl = resolveTargetUrl(opts);
  const redacted = targetUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
  console.log(`\nTarget: ${redacted}`);
  if (opts.wipe) {
    console.log('Mode: WIPE then import (destructive)');
  } else {
    console.log('Mode: MERGE (createMany skipDuplicates)');
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: targetUrl } },
  });

  try {
    try {
      await prisma.$connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      console.error(`
Connection failed. Common fixes for Railway Postgres from a laptop:
  • Use the Public URL (*.proxy.rlwy.net), not postgres.railway.internal
  • Postgres service → Settings → Networking → enable TCP Proxy / Public Networking
  • URL should include ?sslmode=require (this script appends it for *.rlwy.net)
  • If DNS resolves to your ISP (not Railway): switch to 1.1.1.1 / 8.8.8.8, or
    run the import from a Railway one-off shell with the internal DATABASE_URL
See scripts/migrate-local-to-railway.md → Troubleshooting.`);
      process.exit(1);
    }
    await importDump(prisma, dump, opts.wipe);
    console.log('\nDone.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
