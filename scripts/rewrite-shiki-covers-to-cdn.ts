#!/usr/bin/env bun
/**
 * Secondary fallback: rewrite local /uploads/media/cover-shiki{ID}-* coverUrl
 * values back to Shikimori CDN so covers work without uploading ~1GB of media.
 *
 * Does NOT rewrite MediaPhoto (photo-shiki* are screenshots — no CDN path in
 * the filename) or avatars/backgrounds. Sync those via
 * scripts/sync-uploads-to-railway.ts.
 *
 * Usage (dry-run by default):
 *   bun run scripts/rewrite-shiki-covers-to-cdn.ts
 *   bun run scripts/rewrite-shiki-covers-to-cdn.ts --apply
 *   TARGET_DATABASE_URL='postgresql://…' bun run scripts/rewrite-shiki-covers-to-cdn.ts --apply
 */

import { PrismaClient } from '../generated/prisma/index.js';

const SHIKI_COVER = (id: string) =>
  `https://shikimori.io/system/animes/original/${id}.jpg`;

/** Matches filenames like cover-shiki52034-3f86206f5773-3eebed.jpg */
const SHIKI_COVER_PATH_RE =
  /^\/uploads\/media\/cover-shiki(\d+)-[^/]+\.(jpe?g|png|webp|gif)$/i;

function rewriteCoverUrl(url: string): string | null {
  const m = SHIKI_COVER_PATH_RE.exec(url);
  if (!m) return null;
  return SHIKI_COVER(m[1]!);
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes('--apply'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

async function main() {
  const { apply, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(`Rewrite cover-shiki* Media.coverUrl → Shikimori CDN.

  bun run scripts/rewrite-shiki-covers-to-cdn.ts          # dry-run
  bun run scripts/rewrite-shiki-covers-to-cdn.ts --apply  # write DB

Uses DATABASE_URL or TARGET_DATABASE_URL (Railway public proxy + sslmode=require).
MediaPhoto / avatars still need uploads sync.
`);
    return;
  }

  const url =
    process.env.TARGET_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url || url.startsWith('file:')) {
    throw new Error(
      'Need Postgres DATABASE_URL or TARGET_DATABASE_URL (not SQLite file:).',
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  const mediaRows = await prisma.media.findMany({
    where: { coverUrl: { startsWith: '/uploads/media/cover-shiki' } },
    select: { id: true, coverUrl: true },
  });

  const mediaUpdates: Array<{ id: string; from: string; to: string }> = [];
  for (const row of mediaRows) {
    if (!row.coverUrl) continue;
    const to = rewriteCoverUrl(row.coverUrl);
    if (to) mediaUpdates.push({ id: row.id, from: row.coverUrl, to });
  }

  console.log(
    `Media covers to rewrite: ${mediaUpdates.length} (scanned ${mediaRows.length})`,
  );
  for (const sample of mediaUpdates.slice(0, 3)) {
    console.log(`  ${sample.from}`);
    console.log(`  → ${sample.to}`);
  }

  if (!apply) {
    console.log('\nDry-run only. Pass --apply to write.');
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  for (const u of mediaUpdates) {
    await prisma.media.update({
      where: { id: u.id },
      data: { coverUrl: u.to },
    });
    done += 1;
    if (done % 500 === 0) console.log(`  media ${done}/${mediaUpdates.length}`);
  }

  console.log(`Applied: ${mediaUpdates.length} Media.coverUrl`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
