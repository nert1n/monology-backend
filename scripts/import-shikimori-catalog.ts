/**
 * Import Shikimori anime films (kind=movie) and TV series (kind=tv) into the
 * Media catalog as MOVIE / SERIAL. Catalog only — no user shelf Items.
 *
 * Does not touch MediaType.ANIME (leave that to the anime importers).
 * No TMDB keys in env — uses Shikimori kinds as the source.
 *
 * Usage (from backend/):
 *   bun run import:shikimori-movies
 *   bun run import:shikimori-serials
 *   bun run scripts/import-shikimori-catalog.ts --type both
 *   bun run scripts/import-shikimori-catalog.ts --type movie --limit 10
 *   bun run scripts/import-shikimori-catalog.ts --type serial --skip-images
 *   bun run scripts/import-shikimori-catalog.ts --type both --dry-run
 *
 * Safe to re-run: skips existing Media by (type, title, year); fills missing
 * description/year/cover/photos on re-run.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { MediaType, PrismaClient } from '../generated/prisma/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const SHIKI_ORIGIN = 'https://shikimori.io';
const USER_AGENT =
  'monology-list-import/1.0 (local seed; contact: dymufa@gmail.com)';
const MEDIA_PUBLIC_PREFIX = '/uploads/media';
/** Shared with anime importers — same Shikimori anime detail payloads. */
const DETAIL_CACHE_DIR = path.join(
  BACKEND_ROOT,
  'scripts',
  '.cache',
  'shikimori-anime',
);
const UPLOAD_DIR = path.join(BACKEND_ROOT, 'uploads', 'media');
const REQUEST_GAP_MS = 350;
const PAGE_SIZE = 50;
const MAX_PHOTOS_DEFAULT = 4;

type CatalogType = 'movie' | 'serial';
type ShikiKind = 'movie' | 'tv';

type ShikiListItem = {
  id: number;
  name: string;
  russian?: string | null;
  kind?: string | null;
  aired_on?: string | null;
  image?: { original?: string; preview?: string } | null;
};

type ShikiScreenshot = { original: string; preview?: string };
type ShikiAnime = ShikiListItem & {
  description?: string | null;
  screenshots?: ShikiScreenshot[] | null;
};

type CliOptions = {
  types: CatalogType[];
  limit: number | null;
  skipImages: boolean;
  maxPhotos: number;
  dryRun: boolean;
};

const TYPE_CONFIG: Record<
  CatalogType,
  { mediaType: MediaType; shikiKind: ShikiKind; label: string }
> = {
  movie: {
    mediaType: MediaType.MOVIE,
    shikiKind: 'movie',
    label: 'MOVIE (Shikimori kind=movie)',
  },
  serial: {
    mediaType: MediaType.SERIAL,
    shikiKind: 'tv',
    label: 'SERIAL (Shikimori kind=tv)',
  },
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    types: ['movie', 'serial'],
    limit: null,
    skipImages: false,
    maxPhotos: MAX_PHOTOS_DEFAULT,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--type') {
      const raw = (argv[++i] ?? '').toLowerCase();
      if (raw === 'movie' || raw === 'movies') opts.types = ['movie'];
      else if (raw === 'serial' || raw === 'serials' || raw === 'tv') {
        opts.types = ['serial'];
      } else if (raw === 'both' || raw === 'all') {
        opts.types = ['movie', 'serial'];
      } else {
        throw new Error(
          `Invalid --type "${raw}". Use movie | serial | both`,
        );
      }
    } else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--skip-images') opts.skipImages = true;
    else if (arg === '--max-photos') opts.maxPhotos = Number(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`See file header for usage.`);
      process.exit(0);
    }
  }

  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 0)) {
    throw new Error(`Invalid --limit: ${opts.limit}`);
  }
  if (!Number.isFinite(opts.maxPhotos) || opts.maxPhotos < 0) {
    throw new Error(`Invalid --max-photos: ${opts.maxPhotos}`);
  }
  return opts;
}

function yearFromAiredOn(airedOn: string | null | undefined): number | null {
  if (!airedOn) return null;
  const match = /^(\d{4})/.exec(airedOn);
  return match ? Number(match[1]) : null;
}

function stripBbCode(text: string): string {
  return text
    .replace(/\[character=\d+\]([^\]]+)\[\/character\]/gi, '$1')
    .replace(/\[anime=\d+\]([^\]]+)\[\/anime\]/gi, '$1')
    .replace(/\[\[.*?\|(.*?)\]\]/g, '$1')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function absoluteShikiUrl(relativeOrAbsolute: string): string {
  if (relativeOrAbsolute.startsWith('http')) return relativeOrAbsolute;
  return `${SHIKI_ORIGIN}${relativeOrAbsolute.startsWith('/') ? '' : '/'}${relativeOrAbsolute}`;
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
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
  const rand = randomBytes(3).toString('hex');
  return `${prefix}-${hash}-${rand}${extFromUrl(url)}`;
}

function dedupeKey(title: string, year: number | null): string {
  return `${title.toLowerCase()}\0${year ?? ''}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_GAP_MS) {
    await sleep(REQUEST_GAP_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

async function fetchJson<T>(url: string): Promise<T> {
  await throttle();
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    redirect: 'follow',
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '2');
    await sleep(Math.max(1000, retryAfter * 1000));
    return fetchJson(url);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

async function loadShikiAnime(id: number): Promise<ShikiAnime | null> {
  const cachePath = path.join(DETAIL_CACHE_DIR, `${id}.json`);
  try {
    const cached = await readFile(cachePath, 'utf8');
    return JSON.parse(cached) as ShikiAnime;
  } catch {
    // miss
  }

  try {
    const data = await fetchJson<ShikiAnime>(
      `${SHIKI_ORIGIN}/api/animes/${id}`,
    );
    await mkdir(DETAIL_CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(data), 'utf8');
    return data;
  } catch (err) {
    console.warn(`  ! shikimori fetch failed for ${id}:`, err);
    return null;
  }
}

async function downloadImage(
  url: string,
  filename: string,
): Promise<string | null> {
  try {
    await throttle();
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (res.status === 429) {
      await sleep(2000);
      return downloadImage(url, filename);
    }
    if (!res.ok) {
      console.warn(`  ! image HTTP ${res.status}: ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;
    await writeFile(path.join(UPLOAD_DIR, filename), buf);
    return `${MEDIA_PUBLIC_PREFIX}/${filename}`;
  } catch (err) {
    console.warn(`  ! image download failed: ${url}`, err);
    return null;
  }
}

type MediaRow = {
  id: string;
  title: string;
  coverUrl: string | null;
  description: string;
  year: number | null;
  photos: { id: string }[];
};

type TypeStats = {
  listed: number;
  mediaCreated: number;
  mediaSkipped: number;
  mediaUpdated: number;
  coversDownloaded: number;
  photosDownloaded: number;
  failures: number;
};

async function* iterateShikiKind(
  kind: ShikiKind,
  limit: number | null,
): AsyncGenerator<ShikiListItem> {
  let page = 1;
  let yielded = 0;

  while (true) {
    if (limit != null && yielded >= limit) return;

    const pageLimit =
      limit == null
        ? PAGE_SIZE
        : Math.min(PAGE_SIZE, limit - yielded);
    const url =
      `${SHIKI_ORIGIN}/api/animes?kind=${kind}` +
      `&limit=${pageLimit}&order=id&page=${page}`;
    const batch = await fetchJson<ShikiListItem[]>(url);
    if (!Array.isArray(batch) || batch.length === 0) return;

    for (const item of batch) {
      yield item;
      yielded += 1;
      if (limit != null && yielded >= limit) return;
    }

    if (batch.length < pageLimit) return;
    page += 1;
  }
}

async function importCatalogType(
  prisma: PrismaClient,
  catalogType: CatalogType,
  opts: CliOptions,
): Promise<TypeStats> {
  const { mediaType, shikiKind, label } = TYPE_CONFIG[catalogType];
  const stats: TypeStats = {
    listed: 0,
    mediaCreated: 0,
    mediaSkipped: 0,
    mediaUpdated: 0,
    coversDownloaded: 0,
    photosDownloaded: 0,
    failures: 0,
  };

  console.log(`\n--- Importing ${label} ---`);

  const existingMedia = await prisma.media.findMany({
    where: { type: mediaType },
    select: {
      id: true,
      title: true,
      coverUrl: true,
      description: true,
      year: true,
      photos: { select: { id: true }, take: 1 },
    },
  });
  const mediaByKey = new Map(
    existingMedia.map((m) => [dedupeKey(m.title, m.year), m]),
  );

  for await (const entry of iterateShikiKind(shikiKind, opts.limit)) {
    stats.listed += 1;
    const title = entry.name?.trim();
    if (!title) {
      console.warn(`  ! skip shiki#${entry.id}: missing name`);
      stats.failures += 1;
      continue;
    }

    const labelRow = `[${catalogType} ${stats.listed}] ${title}`;
    try {
      const shiki = (await loadShikiAnime(entry.id)) ?? entry;
      const description = shiki.description
        ? stripBbCode(shiki.description)
        : '';
      const year = yearFromAiredOn(shiki.aired_on ?? entry.aired_on ?? null);
      const key = dedupeKey(title, year);

      let media: MediaRow | undefined = mediaByKey.get(key);
      if (!media) {
        const found = await prisma.media.findFirst({
          where: {
            type: mediaType,
            title,
            year: year === null ? null : year,
          },
          select: {
            id: true,
            title: true,
            coverUrl: true,
            description: true,
            year: true,
            photos: { select: { id: true }, take: 1 },
          },
        });
        if (found) {
          media = found;
          mediaByKey.set(key, found);
        }
      }

      let mediaId = media?.id;

      if (!mediaId) {
        if (opts.dryRun) {
          console.log(`${labelRow} → would create media`);
          stats.mediaCreated += 1;
          continue;
        }
        const created = await prisma.media.create({
          data: {
            type: mediaType,
            title,
            description,
            year,
          },
        });
        mediaId = created.id;
        media = {
          id: created.id,
          title: created.title,
          coverUrl: created.coverUrl,
          description: created.description,
          year: created.year,
          photos: [],
        };
        mediaByKey.set(key, media);
        stats.mediaCreated += 1;
      } else {
        stats.mediaSkipped += 1;
        if (
          !opts.dryRun &&
          ((description && !media.description) ||
            (year != null && media.year == null))
        ) {
          await prisma.media.update({
            where: { id: mediaId },
            data: {
              ...(description && !media.description ? { description } : {}),
              ...(year != null && media.year == null ? { year } : {}),
            },
          });
          if (description && !media.description) media.description = description;
          if (year != null && media.year == null) media.year = year;
          stats.mediaUpdated += 1;
        }
      }

      if (!opts.skipImages && !opts.dryRun && mediaId && media) {
        const needsCover = !media.coverUrl;
        const needsPhotos = media.photos.length === 0;
        const imageJobs: Array<Promise<void>> = [];

        if (needsCover && shiki.image?.original) {
          const coverSrc = absoluteShikiUrl(shiki.image.original);
          const filename = uniqueFilename(
            `cover-${catalogType}-shiki${entry.id}`,
            coverSrc,
          );
          imageJobs.push(
            (async () => {
              const publicPath = await downloadImage(coverSrc, filename);
              if (!publicPath) return;
              await prisma.media.update({
                where: { id: mediaId },
                data: { coverUrl: publicPath },
              });
              media!.coverUrl = publicPath;
              stats.coversDownloaded += 1;
            })(),
          );
        }

        if (needsPhotos && opts.maxPhotos > 0) {
          const shots = (shiki.screenshots ?? []).slice(0, opts.maxPhotos);
          shots.forEach((shot, sortOrder) => {
            if (!shot.original) return;
            const src = absoluteShikiUrl(shot.original);
            const filename = uniqueFilename(
              `photo-${catalogType}-shiki${entry.id}`,
              src,
            );
            imageJobs.push(
              (async () => {
                const publicPath = await downloadImage(src, filename);
                if (!publicPath) return;
                await prisma.mediaPhoto.create({
                  data: {
                    mediaId: mediaId!,
                    url: publicPath,
                    sortOrder,
                  },
                });
                stats.photosDownloaded += 1;
                media!.photos = [{ id: '1' }];
              })(),
            );
          });
        }

        if (imageJobs.length > 0) {
          await Promise.all(imageJobs);
        }
      }

      if (stats.listed % 25 === 0) {
        console.log(
          `${labelRow} | +${stats.mediaCreated}/skip ${stats.mediaSkipped}/upd ${stats.mediaUpdated} | covers ${stats.coversDownloaded} photos ${stats.photosDownloaded} | fails ${stats.failures}`,
        );
      }
    } catch (err) {
      stats.failures += 1;
      console.error(`${labelRow} FAILED`, err);
    }
  }

  const total = await prisma.media.count({ where: { type: mediaType } });
  const withCover = await prisma.media.count({
    where: { type: mediaType, coverUrl: { not: null } },
  });
  console.log(
    `${label} done: listed ${stats.listed}, created ${stats.mediaCreated}, skipped ${stats.mediaSkipped}, updated ${stats.mediaUpdated}`,
  );
  console.log(`DB ${mediaType} media: ${total} (with cover: ${withCover})`);
  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN) {
    console.warn(
      'TMDB credentials found in env, but this script uses Shikimori kind mapping (movie→MOVIE, tv→SERIAL).',
    );
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(DETAIL_CACHE_DIR, { recursive: true });

  const prisma = new PrismaClient();
  const animeBefore = await prisma.media.count({
    where: { type: MediaType.ANIME },
  });

  console.log(
    `Shikimori catalog import → types: ${opts.types.join(', ')}` +
      (opts.limit != null ? ` (limit ${opts.limit} each)` : ' (full)') +
      (opts.skipImages ? ', skip-images' : '') +
      (opts.dryRun ? ', dry-run' : ''),
  );
  console.log(`ANIME media before (must stay untouched): ${animeBefore}`);

  const allStats: Record<string, TypeStats> = {};

  try {
    for (const catalogType of opts.types) {
      allStats[catalogType] = await importCatalogType(
        prisma,
        catalogType,
        opts,
      );
    }

    const animeAfter = await prisma.media.count({
      where: { type: MediaType.ANIME },
    });
    const movieCount = await prisma.media.count({
      where: { type: MediaType.MOVIE },
    });
    const serialCount = await prisma.media.count({
      where: { type: MediaType.SERIAL },
    });

    console.log('\n=== Import complete ===');
    console.log(JSON.stringify(allStats, null, 2));
    console.log(
      `ANIME media after: ${animeAfter} (before ${animeBefore}; delta ${animeAfter - animeBefore})`,
    );
    console.log(`MOVIE media: ${movieCount}`);
    console.log(`SERIAL media: ${serialCount}`);
    console.log(`\nRe-run examples:`);
    console.log(`  bun run import:shikimori-movies`);
    console.log(`  bun run import:shikimori-serials`);
    console.log(
      `  bun run scripts/import-shikimori-catalog.ts --type both --limit 20`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
