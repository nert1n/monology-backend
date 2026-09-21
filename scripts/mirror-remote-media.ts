#!/usr/bin/env bun
/**
 * Mirror remote Media.coverUrl / MediaPhoto.url (Shikimori, AniList, others)
 * onto the uploads volume and rewrite DB paths to `/uploads/media/…`.
 *
 * Also recovers missing `/uploads/media/cover-shiki{ID}-*` files from the
 * Shikimori CDN. Null covers are left alone.
 *
 * Usage:
 *   bun run scripts/mirror-remote-media.ts
 *   bun run scripts/mirror-remote-media.ts --apply
 *   UPLOADS_DIR=/app/uploads bun run scripts/mirror-remote-media.ts --apply
 *
 * On Railway, copy this file and run it in the backend container so files
 * land on the volume. DATABASE_URL is already set there.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '../generated/prisma/index.js';

const MEDIA_PUBLIC_PREFIX = '/uploads/media';
const USER_AGENT =
  'monology-list-import/1.0 (local seed; contact: dymufa@gmail.com)';
const SHIKI_COVER_CDN = (id: string) =>
  `https://shikimori.io/system/animes/original/${id}.jpg`;
const SHIKI_COVER_PATH_RE =
  /^\/uploads\/media\/cover-shiki(\d+)-[^/]+\.(jpe?g|png|webp|gif)$/i;
const SHIKI_CDN_ID_RE =
  /(?:shikimori\.(?:io|one)|nyaa\.shikimori\.one)\/system\/animes\/original\/(\d+)\.(?:jpe?g|png|webp|gif)/i;

const CONCURRENCY = 4;
const GAP_MS = 200;

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes('--apply'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function uploadsMediaDir(): string {
  const fromEnv = process.env.UPLOADS_DIR?.trim();
  const root = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(process.cwd(), 'uploads');
  return path.join(root, 'media');
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch {
    // ignore
  }
  return '.jpg';
}

function uniqueFilename(prefix: string, url: string): string {
  const clean = url.split('?')[0] ?? url;
  const hash = createHash('sha1').update(clean).digest('hex').slice(0, 12);
  const rand = randomBytes(3).toString('hex');
  return `${prefix}-${hash}-${rand}${extFromUrl(clean)}`;
}

function isRemote(url: string | null | undefined): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

function isMissingPlaceholder(url: string): boolean {
  return url.includes('/assets/globals/missing_');
}

function shikiIdFromRemote(url: string): string | null {
  const m = SHIKI_CDN_ID_RE.exec(url);
  return m?.[1] ?? null;
}

function shikiIdFromLocalPath(url: string): string | null {
  const m = SHIKI_COVER_PATH_RE.exec(url);
  return m?.[1] ?? null;
}

function indexCoverShiki(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir)) {
    const m = /^cover-shiki(\d+)-/i.exec(name);
    if (m?.[1] && !map.has(m[1])) map.set(m[1], name);
  }
  return map;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadTo(
  url: string,
  destPath: string,
): Promise<boolean> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '2');
    await sleep(Math.max(1000, retryAfter * 1000));
    return downloadTo(url, destPath);
  }
  if (!res.ok) {
    console.warn(`  ! HTTP ${res.status}: ${url}`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    console.warn(`  ! empty body: ${url}`);
    return false;
  }
  await writeFile(destPath, buf);
  return true;
}

async function mapPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await worker(items[idx]!, idx);
    }
  });
  await Promise.all(runners);
}

type Job = {
  kind: 'cover' | 'photo';
  id: string;
  from: string;
  sourceUrl: string | null;
  reuseName: string | null;
  prefix: string;
};

async function main() {
  const { apply, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(`Mirror remote media URLs onto the uploads volume.

  bun run scripts/mirror-remote-media.ts          # dry-run
  bun run scripts/mirror-remote-media.ts --apply  # download + write DB

Uses DATABASE_URL (or TARGET_DATABASE_URL) and UPLOADS_DIR (default cwd/uploads).
`);
    return;
  }

  const dbUrl =
    process.env.TARGET_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!dbUrl || dbUrl.startsWith('file:')) {
    throw new Error(
      'Need Postgres DATABASE_URL or TARGET_DATABASE_URL (not SQLite file:).',
    );
  }

  const mediaDir = uploadsMediaDir();
  mkdirSync(mediaDir, { recursive: true });
  const coverByShikiId = indexCoverShiki(mediaDir);

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();

  const [covers, photos] = await Promise.all([
    prisma.media.findMany({ select: { id: true, coverUrl: true } }),
    prisma.mediaPhoto.findMany({ select: { id: true, url: true } }),
  ]);

  const jobs: Job[] = [];
  let reuse = 0;
  let download = 0;
  let recover = 0;
  let skipOk = 0;
  let skipNull = 0;
  let skipPlaceholder = 0;

  for (const row of covers) {
    const url = row.coverUrl;
    if (!url) {
      skipNull += 1;
      continue;
    }
    if (isMissingPlaceholder(url)) {
      skipPlaceholder += 1;
      continue;
    }
    if (url.startsWith(`${MEDIA_PUBLIC_PREFIX}/`)) {
      const name = url.slice(MEDIA_PUBLIC_PREFIX.length + 1);
      if (existsSync(path.join(mediaDir, name))) {
        skipOk += 1;
        continue;
      }
      const shikiId = shikiIdFromLocalPath(url);
      if (shikiId) {
        const existing = coverByShikiId.get(shikiId);
        if (existing) {
          jobs.push({
            kind: 'cover',
            id: row.id,
            from: url,
            sourceUrl: null,
            reuseName: existing,
            prefix: `cover-shiki${shikiId}`,
          });
          reuse += 1;
          continue;
        }
        jobs.push({
          kind: 'cover',
          id: row.id,
          from: url,
          sourceUrl: SHIKI_COVER_CDN(shikiId),
          reuseName: null,
          prefix: `cover-shiki${shikiId}`,
        });
        recover += 1;
        continue;
      }
      console.warn(`  ! missing local file, no source: ${url}`);
      continue;
    }
    if (isRemote(url)) {
      const shikiId = shikiIdFromRemote(url);
      if (shikiId) {
        const existing = coverByShikiId.get(shikiId);
        if (existing) {
          jobs.push({
            kind: 'cover',
            id: row.id,
            from: url,
            sourceUrl: null,
            reuseName: existing,
            prefix: `cover-shiki${shikiId}`,
          });
          reuse += 1;
          continue;
        }
        jobs.push({
          kind: 'cover',
          id: row.id,
          from: url,
          sourceUrl: url,
          reuseName: null,
          prefix: `cover-shiki${shikiId}`,
        });
        download += 1;
        continue;
      }
      jobs.push({
        kind: 'cover',
        id: row.id,
        from: url,
        sourceUrl: url,
        reuseName: null,
        prefix: 'cover-remote',
      });
      download += 1;
      continue;
    }
  }

  for (const row of photos) {
    const url = row.url;
    if (!url) continue;
    if (isMissingPlaceholder(url)) {
      skipPlaceholder += 1;
      continue;
    }
    if (url.startsWith(`${MEDIA_PUBLIC_PREFIX}/`)) {
      const name = url.slice(MEDIA_PUBLIC_PREFIX.length + 1);
      if (existsSync(path.join(mediaDir, name))) {
        skipOk += 1;
        continue;
      }
      console.warn(`  ! missing photo file: ${url}`);
      continue;
    }
    if (isRemote(url)) {
      jobs.push({
        kind: 'photo',
        id: row.id,
        from: url,
        sourceUrl: url,
        reuseName: null,
        prefix: 'photo-remote',
      });
      download += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mediaDir,
        covers: covers.length,
        photos: photos.length,
        filesIndexed: coverByShikiId.size,
        jobs: jobs.length,
        reuse,
        download,
        recover,
        skipOk,
        skipNull,
        skipPlaceholder,
        apply,
        sample: jobs.slice(0, 4).map((j) => ({
          kind: j.kind,
          from: j.from,
          sourceUrl: j.sourceUrl,
          reuseName: j.reuseName,
        })),
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log('\nDry-run only. Pass --apply to download and write.');
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  let failed = 0;
  let lastTick = Date.now();

  await mapPool(jobs, CONCURRENCY, async (job) => {
    let filename = job.reuseName;
    if (!filename && job.sourceUrl) {
      await sleep(GAP_MS);
      filename = uniqueFilename(job.prefix, job.sourceUrl);
      const dest = path.join(mediaDir, filename);
      const ok = await downloadTo(job.sourceUrl, dest);
      if (!ok) {
        failed += 1;
        return;
      }
    }
    if (!filename) {
      failed += 1;
      return;
    }
    const next = `${MEDIA_PUBLIC_PREFIX}/${filename}`;
    if (job.kind === 'cover') {
      await prisma.media.update({
        where: { id: job.id },
        data: { coverUrl: next },
      });
    } else {
      await prisma.mediaPhoto.update({
        where: { id: job.id },
        data: { url: next },
      });
    }
    done += 1;
    if (done % 100 === 0 || Date.now() - lastTick > 15000) {
      lastTick = Date.now();
      console.log(`  ${done}/${jobs.length} ok, ${failed} failed`);
    }
  });

  console.log(`Applied: ${done} updated, ${failed} failed, ${jobs.length} jobs`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
