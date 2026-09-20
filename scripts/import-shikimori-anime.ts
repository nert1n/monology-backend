/**
 * Import Shikimori anime into the Media catalog (type=ANIME).
 * Catalog only — does NOT create user shelf Items.
 *
 * API: GET /api/animes (paginated, optional season) + GET /api/animes/:id
 * Docs: https://shikimori.io/api/doc/1.0
 *
 * Usage (from backend/):
 *   bun run import:shikimori-anime
 *   bun run import:shikimori-anime-2026
 *   bun run import:shikimori-anime -- --year 2026
 *   bun run import:shikimori-anime -- --year 2026 --limit 10
 *   bun run import:shikimori-anime -- --skip-images
 *   bun run import:shikimori-anime -- --download-images
 *   bun run import:shikimori-anime -- --max-photos 4
 *   bun run import:shikimori-anime -- --page-start 1
 *   bun run import:shikimori-anime -- --dry-run
 *
 * Dedupes by (type=ANIME, title, year). Year-scoped runs use season=YYYY
 * and always fetch details for description/genres/rating/status.
 * Covers default to Shikimori CDN absolute URLs; pass --download-images
 * to mirror locally under /uploads/media.
 *
 * Progress: scripts/.cache/shikimori-anime/_catalog-progress.json
 *   (or _catalog-progress-YEAR.json when --year is set)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  MediaType,
  PrismaClient,
  type ContentRating,
  type MediaStatus,
} from '../generated/prisma/index.js';
import {
  slugifyGenreName,
} from '../src/media/media.helpers.js';
import {
  BACKEND_ROOT,
  CACHE_DIR,
  LIST_PAGE_LIMIT,
  UPLOAD_DIR,
  absoluteShikiUrl,
  downloadImage,
  genreNamesFromShiki,
  isAdultShikiRating,
  isMissingShikiImage,
  listAnimesPage,
  loadShikiAnime,
  mapShikiContentRating,
  mapShikiStatus,
  stripBbCode,
  uniqueFilename,
  yearFromAiredOn,
  type ShikiAnimeListItem,
} from './lib/shikimori.js';

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const MAX_PHOTOS_DEFAULT = 0;

type CliOptions = {
  limit: number | null;
  skipImages: boolean;
  /** Mirror covers/photos under /uploads/media instead of CDN URLs. */
  downloadImages: boolean;
  maxPhotos: number;
  dryRun: boolean;
  pageStart: number | null;
  censored: boolean;
  fetchDetails: boolean;
  year: number | null;
};

type Progress = {
  lastCompletedPage: number;
  processed: number;
  updatedAt: string;
  year: number | null;
};

type MediaCacheRow = {
  id: string;
  title: string;
  coverUrl: string | null;
  description: string;
  year: number | null;
  status: MediaStatus | null;
  episodeCount: number | null;
  episodesAired: number | null;
  contentRating: ContentRating | null;
  isAdult: boolean;
  photos: { id: string }[];
  genreIds: string[];
};

function progressPath(year: number | null): string {
  const name =
    year != null
      ? `_catalog-progress-${year}.json`
      : '_catalog-progress.json';
  return path.join(CACHE_DIR, name);
}

function dedupeKey(title: string, year: number | null): string {
  return `${title.toLowerCase()}::${year ?? ''}`;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: null,
    skipImages: false,
    downloadImages: false,
    maxPhotos: MAX_PHOTOS_DEFAULT,
    dryRun: false,
    pageStart: null,
    censored: false,
    fetchDetails: true,
    year: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--skip-images') opts.skipImages = true;
    else if (arg === '--download-images') opts.downloadImages = true;
    else if (arg === '--max-photos') opts.maxPhotos = Number(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--page-start') opts.pageStart = Number(argv[++i]);
    else if (arg === '--censored') opts.censored = argv[++i] !== 'false';
    else if (arg === '--no-details') opts.fetchDetails = false;
    else if (arg === '--year') opts.year = Number(argv[++i]);
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
  if (
    opts.pageStart != null &&
    (!Number.isFinite(opts.pageStart) || opts.pageStart < 1)
  ) {
    throw new Error(`Invalid --page-start: ${opts.pageStart}`);
  }
  if (
    opts.year != null &&
    (!Number.isFinite(opts.year) || opts.year < 1900 || opts.year > 2100)
  ) {
    throw new Error(`Invalid --year: ${opts.year}`);
  }
  // Year-scoped imports need details for genres/rating/status.
  if (opts.year != null) opts.fetchDetails = true;
  return opts;
}

async function loadProgress(year: number | null): Promise<Progress | null> {
  try {
    const raw = await readFile(progressPath(year), 'utf8');
    return JSON.parse(raw) as Progress;
  } catch {
    return null;
  }
}

async function saveProgress(progress: Progress) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(
    progressPath(progress.year),
    JSON.stringify(progress, null, 2),
    'utf8',
  );
}

async function ensureGenreIds(
  prisma: PrismaClient,
  names: string[],
  cache: Map<string, string>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    let id = cache.get(key);
    if (!id) {
      let slug = slugifyGenreName(name);
      if (!slug) slug = `g-${Date.now().toString(36)}-${ids.length}`;
      let genre = await prisma.genre.findFirst({
        where: { OR: [{ slug }, { name }] },
      });
      if (!genre) {
        genre = await prisma.genre.create({ data: { name, slug } });
      }
      id = genre.id;
      cache.set(key, id);
    }
    ids.push(id);
  }
  return ids;
}

function sameGenreSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const prisma = new PrismaClient();
  const genreCache = new Map<string, string>();
  const stats = {
    pages: 0,
    seen: 0,
    mediaCreated: 0,
    mediaSkipped: 0,
    mediaUpdated: 0,
    coversSet: 0,
    photosDownloaded: 0,
    failures: 0,
  };

  try {
    const prior = await loadProgress(opts.year);
    let page = 1;
    if (opts.pageStart != null) {
      page = opts.pageStart;
    } else if (prior?.lastCompletedPage) {
      page = prior.lastCompletedPage + 1;
      console.log(
        `Resuming after page ${prior.lastCompletedPage} (pass --page-start 1 to restart)`,
      );
    }

    const season = opts.year != null ? String(opts.year) : undefined;
    console.log(
      `Catalog import: year=${opts.year ?? 'all'}, season=${season ?? '—'}, page≥${page}, limit=${opts.limit ?? '∞'}, images=${!opts.skipImages}, download=${opts.downloadImages}, maxPhotos=${opts.maxPhotos}, details=${opts.fetchDetails}, censored=${opts.censored}`,
    );
    if (opts.dryRun) console.log('Dry run — no DB/file writes.');

    const existingMedia = await prisma.media.findMany({
      where: {
        type: MediaType.ANIME,
        ...(opts.year != null ? { year: opts.year } : {}),
      },
      select: {
        id: true,
        title: true,
        coverUrl: true,
        description: true,
        year: true,
        status: true,
        episodeCount: true,
        episodesAired: true,
        contentRating: true,
        isAdult: true,
        photos: { select: { id: true }, take: 1 },
        genres: { select: { genreId: true } },
      },
    });
    const mediaByKey = new Map<string, MediaCacheRow>(
      existingMedia.map((m) => [
        dedupeKey(m.title, m.year),
        {
          id: m.id,
          title: m.title,
          coverUrl: m.coverUrl,
          description: m.description,
          year: m.year,
          status: m.status,
          episodeCount: m.episodeCount,
          episodesAired: m.episodesAired,
          contentRating: m.contentRating,
          isAdult: m.isAdult,
          photos: m.photos,
          genreIds: m.genres.map((g) => g.genreId),
        },
      ]),
    );
    console.log(
      `Existing ANIME media in DB` +
        (opts.year != null ? ` (year=${opts.year})` : '') +
        `: ${existingMedia.length}`,
    );

    let reachedEnd = false;
    while (!reachedEnd) {
      let pageItems: ShikiAnimeListItem[];
      try {
        pageItems = await listAnimesPage({
          page,
          limit: LIST_PAGE_LIMIT,
          order: 'id',
          censored: opts.censored,
          season,
        });
      } catch (err) {
        stats.failures += 1;
        console.error(`Page ${page} list FAILED`, err);
        break;
      }

      if (!Array.isArray(pageItems) || pageItems.length === 0) {
        reachedEnd = true;
        console.log(`Empty page ${page} — catalog end.`);
        break;
      }

      stats.pages += 1;
      console.log(
        `--- page ${page} (${pageItems.length} items, ids ${pageItems[0]?.id}–${pageItems.at(-1)?.id}) ---`,
      );

      for (let i = 0; i < pageItems.length; i++) {
        if (opts.limit != null && stats.seen >= opts.limit) {
          reachedEnd = true;
          break;
        }

        const item = pageItems[i];
        stats.seen += 1;
        const title = item.name?.trim();
        if (!title) {
          console.warn(`  ! skip id=${item.id}: missing name`);
          stats.failures += 1;
          continue;
        }

        const label = `[${stats.seen}] #${item.id} ${title}`;
        try {
          let year = yearFromAiredOn(item.aired_on);
          if (opts.year != null && year == null) year = opts.year;

          const key = dedupeKey(title, year);
          let media = mediaByKey.get(key);
          if (!media) {
            const found = await prisma.media.findFirst({
              where: {
                type: MediaType.ANIME,
                title,
                ...(year != null ? { year } : { year: null }),
              },
              select: {
                id: true,
                title: true,
                coverUrl: true,
                description: true,
                year: true,
                status: true,
                episodeCount: true,
                episodesAired: true,
                contentRating: true,
                isAdult: true,
                photos: { select: { id: true }, take: 1 },
                genres: { select: { genreId: true } },
              },
            });
            if (found) {
              media = {
                ...found,
                genreIds: found.genres.map((g) => g.genreId),
              };
              mediaByKey.set(key, media);
            }
          }

          const needsPhotosDetail =
            !opts.skipImages &&
            opts.maxPhotos > 0 &&
            opts.downloadImages &&
            (!media || media.photos.length === 0);

          let description = media?.description ?? '';
          let coverRel = item.image?.original ?? null;
          let screenshots: { original: string }[] = [];
          let status = mapShikiStatus(item.status);
          let episodeCount =
            item.episodes && item.episodes > 0 ? item.episodes : null;
          let episodesAired =
            item.episodes_aired && item.episodes_aired > 0
              ? item.episodes_aired
              : null;
          let contentRating = mapShikiContentRating(item.rating);
          let isAdult = isAdultShikiRating(item.rating);
          let genreNames: string[] = [];

          if (opts.fetchDetails || needsPhotosDetail) {
            const detail = await loadShikiAnime(item.id);
            if (detail) {
              if (detail.description) {
                description = stripBbCode(detail.description);
              }
              if (detail.aired_on) {
                year = yearFromAiredOn(detail.aired_on) ?? year;
              }
              if (opts.year != null && year == null) year = opts.year;
              if (detail.image?.original) {
                coverRel = detail.image.original;
              }
              screenshots = detail.screenshots ?? [];
              status = mapShikiStatus(detail.status) ?? status;
              if (detail.episodes && detail.episodes > 0) {
                episodeCount = detail.episodes;
              }
              if (detail.episodes_aired && detail.episodes_aired > 0) {
                episodesAired = detail.episodes_aired;
              }
              contentRating =
                mapShikiContentRating(detail.rating) ?? contentRating;
              isAdult = isAdultShikiRating(detail.rating) || isAdult;
              genreNames = genreNamesFromShiki(detail.genres);
            }
          }

          let genreIds: string[] = media?.genreIds ?? [];
          if (!opts.dryRun && genreNames.length > 0) {
            genreIds = await ensureGenreIds(prisma, genreNames, genreCache);
          }

          let coverUrl: string | null = null;
          if (
            !opts.skipImages &&
            coverRel &&
            !isMissingShikiImage(coverRel)
          ) {
            if (opts.downloadImages && !opts.dryRun) {
              const coverSrc = absoluteShikiUrl(coverRel);
              const filename = uniqueFilename(
                `cover-shiki${item.id}`,
                coverSrc,
              );
              coverUrl = await downloadImage(coverSrc, filename);
            } else if (!opts.downloadImages) {
              coverUrl = absoluteShikiUrl(coverRel);
            }
          }

          let mediaId = media?.id;

          if (!mediaId) {
            if (opts.dryRun) {
              console.log(`${label} → would create`);
              stats.mediaCreated += 1;
              continue;
            }
            const created = await prisma.media.create({
              data: {
                type: MediaType.ANIME,
                title,
                description,
                year,
                coverUrl,
                status,
                episodeCount,
                episodesAired,
                contentRating,
                isAdult,
                ...(genreIds.length > 0
                  ? {
                      genres: {
                        create: genreIds.map((genreId) => ({ genreId })),
                      },
                    }
                  : {}),
              },
            });
            mediaId = created.id;
            media = {
              id: created.id,
              title: created.title,
              coverUrl: created.coverUrl,
              description: created.description,
              year: created.year,
              status: created.status,
              episodeCount: created.episodeCount,
              episodesAired: created.episodesAired,
              contentRating: created.contentRating,
              isAdult: created.isAdult,
              photos: [],
              genreIds,
            };
            mediaByKey.set(dedupeKey(title, year), media);
            stats.mediaCreated += 1;
            if (coverUrl) stats.coversSet += 1;
          } else if (media) {
            const patch: {
              description?: string;
              year?: number | null;
              coverUrl?: string | null;
              status?: MediaStatus | null;
              episodeCount?: number | null;
              episodesAired?: number | null;
              contentRating?: ContentRating | null;
              isAdult?: boolean;
            } = {};

            if (description && description !== media.description) {
              patch.description = description;
            }
            if (year != null && media.year !== year) patch.year = year;
            if (coverUrl && coverUrl !== media.coverUrl) {
              patch.coverUrl = coverUrl;
            }
            if (status != null && status !== media.status) {
              patch.status = status;
            }
            if (
              episodeCount != null &&
              episodeCount !== media.episodeCount
            ) {
              patch.episodeCount = episodeCount;
            }
            if (
              episodesAired != null &&
              episodesAired !== media.episodesAired
            ) {
              patch.episodesAired = episodesAired;
            }
            if (
              contentRating != null &&
              contentRating !== media.contentRating
            ) {
              patch.contentRating = contentRating;
            }
            if (isAdult !== media.isAdult) patch.isAdult = isAdult;

            const genresChanged =
              genreIds.length > 0 && !sameGenreSet(genreIds, media.genreIds);

            if (
              Object.keys(patch).length === 0 &&
              !genresChanged
            ) {
              stats.mediaSkipped += 1;
            } else if (opts.dryRun) {
              console.log(`${label} → would update`);
              stats.mediaUpdated += 1;
            } else {
              await prisma.media.update({
                where: { id: mediaId },
                data: {
                  ...patch,
                  ...(genresChanged
                    ? {
                        genres: {
                          deleteMany: {},
                          create: genreIds.map((genreId) => ({ genreId })),
                        },
                      }
                    : {}),
                },
              });
              Object.assign(media, patch);
              if (genresChanged) media.genreIds = genreIds;
              if (patch.coverUrl) stats.coversSet += 1;
              stats.mediaUpdated += 1;
            }
          }

          if (
            opts.downloadImages &&
            !opts.skipImages &&
            !opts.dryRun &&
            mediaId &&
            media &&
            opts.maxPhotos > 0 &&
            media.photos.length === 0
          ) {
            const shots = screenshots.slice(0, opts.maxPhotos);
            for (let sortOrder = 0; sortOrder < shots.length; sortOrder++) {
              const shot = shots[sortOrder];
              if (!shot?.original || isMissingShikiImage(shot.original)) {
                continue;
              }
              const src = absoluteShikiUrl(shot.original);
              const filename = uniqueFilename(`photo-shiki${item.id}`, src);
              const publicPath = await downloadImage(src, filename);
              if (!publicPath) continue;
              await prisma.mediaPhoto.create({
                data: { mediaId, url: publicPath, sortOrder },
              });
              stats.photosDownloaded += 1;
              media.photos = [{ id: '1' }];
            }
          }

          if (stats.seen % 25 === 0) {
            console.log(
              `${label} | +${stats.mediaCreated}/skip ${stats.mediaSkipped}/upd ${stats.mediaUpdated} | covers ${stats.coversSet} photos ${stats.photosDownloaded} | fails ${stats.failures}`,
            );
          }
        } catch (err) {
          stats.failures += 1;
          console.error(`${label} FAILED`, err);
        }
      }

      if (!opts.dryRun && opts.limit == null) {
        await saveProgress({
          lastCompletedPage: page,
          processed: stats.seen,
          updatedAt: new Date().toISOString(),
          year: opts.year,
        });
      }

      if (reachedEnd || (opts.limit != null && stats.seen >= opts.limit)) {
        break;
      }
      page += 1;
    }

    const animeWhere = {
      type: MediaType.ANIME,
      ...(opts.year != null ? { year: opts.year } : {}),
    };
    const animeMediaCount = await prisma.media.count({ where: animeWhere });
    const withCover = await prisma.media.count({
      where: { ...animeWhere, coverUrl: { not: null } },
    });

    console.log('\n=== Catalog import complete ===');
    console.log(JSON.stringify(stats, null, 2));
    console.log(
      `DB ANIME media` +
        (opts.year != null ? ` year=${opts.year}` : '') +
        `: ${animeMediaCount} (with cover: ${withCover})`,
    );
    if (opts.year != null) {
      console.log(
        `Re-run: bun run import:shikimori-anime -- --year ${opts.year}\n` +
          `Force from start: bun run import:shikimori-anime -- --year ${opts.year} --page-start 1\n` +
          `Or: bun run import:shikimori-anime-2026`,
      );
    } else {
      console.log(
        `Re-run: bun run import:shikimori-anime  (resumes from checkpoint)\n` +
          `Force from start: bun run import:shikimori-anime -- --page-start 1\n` +
          `Smoke: bun run import:shikimori-anime -- --limit 10`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
