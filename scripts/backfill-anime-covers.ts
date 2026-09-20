/**
 * Backfill missing Media covers + gallery photos for ANIME.
 *
 * Shikimori season imports often leave covers null when the CDN still has the
 * `missing_original` placeholder. This script fills gaps from:
 *   1. Shikimori poster (CDN) when a real image appears
 *   2. AniList cover (CDN) when Shikimori has none
 *   3. Jikan/MAL cover when AniList has none
 *   4. First Shikimori screenshot as cover fallback
 * Gallery: Shikimori screenshots (CDN URLs by default; optional local mirror).
 *
 * Usage (from backend/):
 *   bun run backfill:anime-covers
 *   bun run backfill:anime-covers -- --year 2026
 *   bun run backfill:anime-covers -- --year 2026 --limit 20
 *   bun run backfill:anime-covers -- --max-photos 4
 *   bun run backfill:anime-covers -- --download-images
 *   bun run backfill:anime-covers -- --covers-only
 *   bun run backfill:anime-covers -- --photos-only
 *   bun run backfill:anime-covers -- --skip-anilist
 *   bun run backfill:anime-covers -- --skip-jikan
 *   bun run backfill:anime-covers -- --dry-run --limit 10
 *   bun run backfill:anime-covers -- --reset-progress
 *
 * Safe to re-run: only Media still missing coverUrl / gallery are selected.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { MediaType, PrismaClient } from '../generated/prisma/index.js';
import {
  aniListCoverUrl,
  pickAniListMatch,
  searchAniListAnime,
} from './lib/anilist.js';
import {
  jikanCoverUrl,
  pickJikanMatch,
  searchJikanAnime,
} from './lib/jikan.js';
import {
  BACKEND_ROOT,
  CACHE_DIR,
  UPLOAD_DIR,
  absoluteShikiUrl,
  downloadImage,
  isMissingShikiImage,
  loadShikiAnime,
  searchAnimes,
  shikiCoverRel,
  uniqueFilename,
  yearFromAiredOn,
  type ShikiAnime,
  type ShikiAnimeListItem,
} from './lib/shikimori.js';

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const MAX_PHOTOS_DEFAULT = 4;

type CliOptions = {
  year: number | null;
  limit: number | null;
  maxPhotos: number;
  downloadImages: boolean;
  coversOnly: boolean;
  photosOnly: boolean;
  dryRun: boolean;
  resetProgress: boolean;
  skipAniList: boolean;
  skipJikan: boolean;
};

type Progress = {
  processedIds: string[];
  updatedAt: string;
  year: number | null;
  stats: Record<string, number>;
};

type TargetRow = {
  id: string;
  title: string;
  year: number | null;
  coverUrl: string | null;
  photoCount: number;
};

function progressPath(year: number | null): string {
  const name =
    year != null
      ? `_backfill-covers-progress-${year}.json`
      : '_backfill-covers-progress.json';
  return path.join(CACHE_DIR, name);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    year: null,
    limit: null,
    maxPhotos: MAX_PHOTOS_DEFAULT,
    downloadImages: false,
    coversOnly: false,
    photosOnly: false,
    dryRun: false,
    resetProgress: false,
    skipAniList: false,
    skipJikan: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--year') opts.year = Number(argv[++i]);
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--max-photos') opts.maxPhotos = Number(argv[++i]);
    else if (arg === '--download-images') opts.downloadImages = true;
    else if (arg === '--covers-only') opts.coversOnly = true;
    else if (arg === '--photos-only') opts.photosOnly = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--reset-progress') opts.resetProgress = true;
    else if (arg === '--skip-anilist') opts.skipAniList = true;
    else if (arg === '--skip-jikan') opts.skipJikan = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`See file header for usage.`);
      process.exit(0);
    }
  }
  if (opts.coversOnly && opts.photosOnly) {
    throw new Error('Use either --covers-only or --photos-only, not both.');
  }
  if (
    opts.year != null &&
    (!Number.isFinite(opts.year) || opts.year < 1900 || opts.year > 2100)
  ) {
    throw new Error(`Invalid --year: ${opts.year}`);
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 0)) {
    throw new Error(`Invalid --limit: ${opts.limit}`);
  }
  if (!Number.isFinite(opts.maxPhotos) || opts.maxPhotos < 0) {
    throw new Error(`Invalid --max-photos: ${opts.maxPhotos}`);
  }
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

function titleKey(title: string): string {
  return title.toLowerCase().trim();
}

/**
 * Index Shikimori detail cache by English/romaji/russian names.
 * Cache payloads include `name`, `russian`, `english[]`, `synonyms[]`.
 */
async function buildShikiTitleIndex(): Promise<Map<string, number>> {
  const index = new Map<string, number>();
  let files: string[] = [];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return index;
  }
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const id = Number(file.replace(/\.json$/, ''));
    if (!Number.isFinite(id)) continue;
    try {
      const raw = await readFile(path.join(CACHE_DIR, file), 'utf8');
      const data = JSON.parse(raw) as ShikiAnime & {
        english?: (string | null)[] | null;
        synonyms?: (string | null)[] | null;
      };
      const names = [
        data.name,
        data.russian,
        ...(data.english ?? []),
        ...(data.synonyms ?? []),
      ];
      for (const n of names) {
        if (!n || typeof n !== 'string') continue;
        const key = titleKey(n);
        if (key && !index.has(key)) index.set(key, id);
      }
    } catch {
      // skip corrupt cache rows
    }
  }
  return index;
}

function pickShikiSearchHit(
  hits: ShikiAnimeListItem[],
  title: string,
  year: number | null,
): ShikiAnimeListItem | null {
  if (!hits.length) return null;
  const want = titleKey(title);
  const scored = hits.map((h) => {
    let score = 0;
    const names = [h.name, h.russian].filter(Boolean).map((n) => titleKey(n!));
    if (names.includes(want)) score += 5;
    else if (names.some((n) => n.includes(want) || want.includes(n))) score += 2;
    const airedYear = yearFromAiredOn(h.aired_on);
    if (year != null && airedYear === year) score += 10;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 2) return null;
  return best.h;
}

async function resolveImageUrl(
  src: string,
  filenamePrefix: string,
  download: boolean,
  dryRun: boolean,
): Promise<string | null> {
  const absolute = absoluteShikiUrl(src);
  if (!download) return absolute.startsWith('http') ? absolute : absoluteShikiUrl(src);
  if (dryRun) return absolute;
  // AniList / absolute CDN — downloadImage accepts full URLs.
  const filename = uniqueFilename(filenamePrefix, absolute);
  return downloadImage(absolute, filename);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const prisma = new PrismaClient();
  const stats = {
    candidates: 0,
    seen: 0,
    coversFromShiki: 0,
    coversFromAniList: 0,
    coversFromJikan: 0,
    coversFromScreenshot: 0,
    coversUnchanged: 0,
    coversStillMissing: 0,
    photosAdded: 0,
    photosSkipped: 0,
    shikiMiss: 0,
    failures: 0,
  };

  try {
    let prior = opts.resetProgress ? null : await loadProgress(opts.year);
    // Progress is informational only — candidates come from DB (null cover /
    // empty gallery), so re-runs retry titles that still need images.
    const done = new Set<string>();
    if (opts.resetProgress) {
      console.log('Progress reset.');
    } else if (prior?.processedIds?.length) {
      console.log(
        `Prior run processed ${prior.processedIds.length} id(s); re-querying DB for remaining gaps.`,
      );
    }

    const needCover = !opts.photosOnly;
    const needPhotos = !opts.coversOnly && opts.maxPhotos > 0;
    if (!needCover && !needPhotos) {
      throw new Error(
        'Nothing to do: enable covers and/or set --max-photos > 0.',
      );
    }

    const orFilters: Array<
      { coverUrl: null } | { photos: { none: Record<string, never> } }
    > = [];
    if (needCover) orFilters.push({ coverUrl: null });
    if (needPhotos) orFilters.push({ photos: { none: {} } });

    const where = {
      type: MediaType.ANIME,
      ...(opts.year != null ? { year: opts.year } : {}),
      OR: orFilters,
    };

    const rows = await prisma.media.findMany({
      where,
      select: {
        id: true,
        title: true,
        year: true,
        coverUrl: true,
        _count: { select: { photos: true } },
      },
      orderBy: [{ year: 'asc' }, { title: 'asc' }],
    });

    const targets: TargetRow[] = rows
      .map((r) => ({
        id: r.id,
        title: r.title,
        year: r.year,
        coverUrl: r.coverUrl,
        photoCount: r._count.photos,
      }))
      .filter((r) => {
        const wantsCover = needCover && !r.coverUrl;
        const wantsPhotos = needPhotos && r.photoCount === 0;
        return wantsCover || wantsPhotos;
      });

    stats.candidates = targets.length;
    console.log(
      `Backfill anime covers/photos: year=${opts.year ?? 'all'}, candidates=${targets.length}, ` +
        `maxPhotos=${opts.maxPhotos}, download=${opts.downloadImages}, ` +
        `anilist=${!opts.skipAniList}, jikan=${!opts.skipJikan}, ` +
        `covers=${needCover}, photos=${needPhotos}`,
    );
    if (opts.dryRun) console.log('Dry run — no DB/file writes.');

    console.log('Indexing Shikimori detail cache…');
    const shikiIndex = await buildShikiTitleIndex();
    console.log(`  cache title keys: ${shikiIndex.size}`);

    const progress: Progress = {
      processedIds: [...done],
      updatedAt: new Date().toISOString(),
      year: opts.year,
      stats: {},
    };

    for (const row of targets) {
      if (opts.limit != null && stats.seen >= opts.limit) break;

      stats.seen += 1;
      const label = `[${stats.seen}/${opts.limit ?? targets.length}] ${row.title}${row.year != null ? ` (${row.year})` : ''}`;

      try {
        let shikiId = shikiIndex.get(titleKey(row.title)) ?? null;
        let listHit: ShikiAnimeListItem | null = null;

        if (shikiId == null) {
          const hits = await searchAnimes({
            search: row.title,
            limit: 8,
            censored: false,
          });
          listHit = pickShikiSearchHit(hits, row.title, row.year);
          shikiId = listHit?.id ?? null;
          if (shikiId != null) shikiIndex.set(titleKey(row.title), shikiId);
        }

        let detail: ShikiAnime | null = null;
        if (shikiId != null) {
          detail = await loadShikiAnime(shikiId);
        } else {
          stats.shikiMiss += 1;
        }

        const screenshots = (detail?.screenshots ?? [])
          .map((s) => s.original)
          .filter((u): u is string => !!u && !isMissingShikiImage(u));

        // --- Cover ---
        let coverSet = false;
        if (needCover && !row.coverUrl) {
          let coverUrl: string | null = null;
          let source: 'shiki' | 'anilist' | 'jikan' | 'screenshot' | null =
            null;

          const coverRel =
            shikiCoverRel(detail?.image) ??
            shikiCoverRel(listHit?.image) ??
            null;
          if (coverRel) {
            coverUrl = await resolveImageUrl(
              coverRel,
              `cover-shiki${shikiId ?? 'x'}`,
              opts.downloadImages,
              opts.dryRun,
            );
            source = 'shiki';
          }

          if (!coverUrl && !opts.skipAniList) {
            try {
              const hits = await searchAniListAnime(row.title, 5);
              const match = pickAniListMatch(hits, row.title, row.year);
              const aniUrl = match ? aniListCoverUrl(match) : null;
              if (aniUrl) {
                if (opts.downloadImages && !opts.dryRun) {
                  const filename = uniqueFilename(
                    `cover-anilist${match!.id}`,
                    aniUrl,
                  );
                  coverUrl = await downloadImage(aniUrl, filename);
                } else {
                  coverUrl = aniUrl;
                }
                source = 'anilist';
              }
            } catch (err) {
              console.warn(`  ! AniList failed for ${row.title}:`, err);
            }
          }

          if (!coverUrl && !opts.skipJikan) {
            try {
              const hits = await searchJikanAnime(row.title, 5);
              const match = pickJikanMatch(hits, row.title, row.year);
              const malUrl = match ? jikanCoverUrl(match) : null;
              if (malUrl) {
                if (opts.downloadImages && !opts.dryRun) {
                  const filename = uniqueFilename(
                    `cover-mal${match!.mal_id}`,
                    malUrl,
                  );
                  coverUrl = await downloadImage(malUrl, filename);
                } else {
                  coverUrl = malUrl;
                }
                source = 'jikan';
              }
            } catch (err) {
              console.warn(`  ! Jikan failed for ${row.title}:`, err);
            }
          }

          if (!coverUrl && screenshots[0]) {
            coverUrl = await resolveImageUrl(
              screenshots[0],
              `cover-shot-shiki${shikiId ?? 'x'}`,
              opts.downloadImages,
              opts.dryRun,
            );
            source = 'screenshot';
          }

          if (coverUrl) {
            if (!opts.dryRun) {
              await prisma.media.update({
                where: { id: row.id },
                data: { coverUrl },
              });
            }
            coverSet = true;
            if (source === 'shiki') stats.coversFromShiki += 1;
            else if (source === 'anilist') stats.coversFromAniList += 1;
            else if (source === 'jikan') stats.coversFromJikan += 1;
            else if (source === 'screenshot') stats.coversFromScreenshot += 1;
            console.log(`${label} → cover (${source})`);
          } else {
            stats.coversStillMissing += 1;
          }
        } else if (row.coverUrl) {
          stats.coversUnchanged += 1;
        }

        // --- Gallery ---
        if (needPhotos && row.photoCount === 0) {
          const shots = screenshots.slice(0, opts.maxPhotos);
          if (shots.length === 0) {
            stats.photosSkipped += 1;
          } else if (opts.dryRun) {
            stats.photosAdded += shots.length;
            console.log(`${label} → would add ${shots.length} photo(s)`);
          } else {
            let added = 0;
            for (let sortOrder = 0; sortOrder < shots.length; sortOrder++) {
              const shot = shots[sortOrder];
              const url = await resolveImageUrl(
                shot,
                `photo-shiki${shikiId ?? 'x'}`,
                opts.downloadImages,
                false,
              );
              if (!url) continue;
              await prisma.mediaPhoto.create({
                data: { mediaId: row.id, url, sortOrder },
              });
              added += 1;
            }
            stats.photosAdded += added;
            if (added) {
              console.log(
                `${label} → +${added} photo(s)${coverSet ? '' : ' (gallery only)'}`,
              );
            } else {
              stats.photosSkipped += 1;
            }
          }
        }

        done.add(row.id);
        progress.processedIds = [...done];
        progress.updatedAt = new Date().toISOString();
        progress.stats = { ...stats };
        if (!opts.dryRun && stats.seen % 10 === 0) {
          await saveProgress(progress);
        }
      } catch (err) {
        stats.failures += 1;
        console.error(`${label} FAILED`, err);
      }
    }

    if (!opts.dryRun) {
      progress.stats = { ...stats };
      progress.updatedAt = new Date().toISOString();
      await saveProgress(progress);
    }

    const animeWhere = {
      type: MediaType.ANIME,
      ...(opts.year != null ? { year: opts.year } : {}),
    };
    const total = await prisma.media.count({ where: animeWhere });
    const withCover = await prisma.media.count({
      where: { ...animeWhere, coverUrl: { not: null } },
    });
    const withoutCover = await prisma.media.count({
      where: { ...animeWhere, coverUrl: null },
    });
    const withPhotos = await prisma.media.count({
      where: { ...animeWhere, photos: { some: {} } },
    });
    const withoutPhotos = await prisma.media.count({
      where: { ...animeWhere, photos: { none: {} } },
    });

    console.log('\n=== Backfill complete ===');
    console.log(JSON.stringify(stats, null, 2));
    console.log(
      `DB ANIME` +
        (opts.year != null ? ` year=${opts.year}` : '') +
        `: ${total} | with cover: ${withCover} | without cover: ${withoutCover}`,
    );
    console.log(
      `Galleries: with photos: ${withPhotos} | without photos: ${withoutPhotos}`,
    );
    console.log(
      `Re-run: bun run backfill:anime-covers` +
        (opts.year != null ? ` -- --year ${opts.year}` : '') +
        `\nReset: bun run backfill:anime-covers -- --reset-progress` +
        (opts.year != null ? ` --year ${opts.year}` : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
