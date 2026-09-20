/**
 * Import Shikimori anime list JSON into Media catalog + nert1n's Anime shelf.
 *
 * Usage (from backend/):
 *   bun run scripts/import-nert1n-animes.ts
 *   bun run scripts/import-nert1n-animes.ts --limit 10
 *   bun run scripts/import-nert1n-animes.ts --json /path/to/file.json
 *   bun run scripts/import-nert1n-animes.ts --skip-images
 *   bun run scripts/import-nert1n-animes.ts --max-photos 4
 *
 * Safe to re-run: skips existing Media by (type=ANIME, title) and existing
 * Items by (categoryId, mediaId). Fills missing cover/photos on re-run.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  ItemStatus,
  MediaType,
  PrismaClient,
} from '../generated/prisma/index.js';
import {
  BACKEND_ROOT,
  CACHE_DIR,
  UPLOAD_DIR,
  absoluteShikiUrl,
  downloadImage,
  loadShikiAnime,
  stripBbCode,
  uniqueFilename,
  yearFromAiredOn,
} from './lib/shikimori.js';

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const DEFAULT_JSON = '/home/maksim/Downloads/nert1n_animes.json';
const USERNAME = 'nert1n';
const MAX_PHOTOS_DEFAULT = 4;

type ListEntry = {
  target_title: string;
  target_title_ru: string | null;
  target_id: number;
  target_type: string;
  score: number | null;
  status: string;
  rewatches: number | null;
  episodes: number | null;
  text: string | null;
};

type CliOptions = {
  jsonPath: string;
  limit: number | null;
  skipImages: boolean;
  maxPhotos: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    jsonPath: DEFAULT_JSON,
    limit: null,
    skipImages: false,
    maxPhotos: MAX_PHOTOS_DEFAULT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.jsonPath = argv[++i] ?? opts.jsonPath;
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
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

function mapStatus(raw: string): ItemStatus {
  switch (raw) {
    case 'completed':
      return ItemStatus.DONE;
    case 'watching':
      return ItemStatus.IN_PROGRESS;
    case 'dropped':
      return ItemStatus.DROPPED;
    case 'paused':
    case 'on_hold':
      return ItemStatus.PAUSED;
    case 'planned':
      return ItemStatus.PLANNED;
    default:
      return ItemStatus.PLANNED;
  }
}

function mapRating(score: number | null | undefined): number | null {
  if (score == null || score <= 0) return null;
  return score;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readFile(opts.jsonPath, 'utf8');
  let entries = JSON.parse(raw) as ListEntry[];
  if (!Array.isArray(entries)) {
    throw new Error('JSON root must be an array');
  }
  if (opts.limit != null) {
    entries = entries.slice(0, opts.limit);
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const prisma = new PrismaClient();

  const stats = {
    mediaCreated: 0,
    mediaSkipped: 0,
    mediaUpdated: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    coversDownloaded: 0,
    photosDownloaded: 0,
    failures: 0,
  };

  try {
    const user = await prisma.user.findUnique({
      where: { username: USERNAME },
      include: {
        categories: { where: { kind: 'ANIME' } },
      },
    });
    if (!user) {
      throw new Error(`User ${USERNAME} not found`);
    }
    const animeCategory = user.categories[0];
    if (!animeCategory) {
      throw new Error(`User ${USERNAME} has no ANIME category`);
    }

    console.log(
      `Importing ${entries.length} entries for @${user.username} → category ${animeCategory.name} (${animeCategory.id})`,
    );
    if (opts.dryRun)
      console.log(
        'Dry run — no DB/file writes for media/items (cache still used).',
      );

    const existingMedia = await prisma.media.findMany({
      where: { type: MediaType.ANIME },
      select: {
        id: true,
        title: true,
        coverUrl: true,
        description: true,
        year: true,
        photos: { select: { id: true }, take: 1 },
      },
    });
    const mediaByTitle = new Map(
      existingMedia.map((m) => [m.title.toLowerCase(), m]),
    );

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const title = entry.target_title?.trim();
      if (!title) {
        console.warn(`  ! skip row ${i}: missing title`);
        stats.failures += 1;
        continue;
      }

      const label = `[${i + 1}/${entries.length}] ${title}`;
      try {
        const shiki = await loadShikiAnime(entry.target_id);
        const description = shiki?.description
          ? stripBbCode(shiki.description)
          : '';
        const year = yearFromAiredOn(shiki?.aired_on ?? null);

        let media = mediaByTitle.get(title.toLowerCase());
        if (!media) {
          const found = await prisma.media.findFirst({
            where: { type: MediaType.ANIME, title },
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
            mediaByTitle.set(title.toLowerCase(), found);
          }
        }
        let mediaId = media?.id;

        if (!mediaId) {
          if (opts.dryRun) {
            console.log(`${label} → would create media`);
            stats.mediaCreated += 1;
            continue;
          }
          const created = await prisma.media.create({
            data: {
              type: MediaType.ANIME,
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
          mediaByTitle.set(title.toLowerCase(), media);
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
            stats.mediaUpdated += 1;
          }
        }

        if (!opts.skipImages && !opts.dryRun && mediaId) {
          const needsCover = !media?.coverUrl;
          const needsPhotos = (media?.photos.length ?? 0) === 0;

          const imageJobs: Array<Promise<void>> = [];

          if (needsCover && shiki?.image?.original) {
            const coverSrc = absoluteShikiUrl(shiki.image.original);
            const filename = uniqueFilename(
              `cover-shiki${entry.target_id}`,
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
                if (media) media.coverUrl = publicPath;
                stats.coversDownloaded += 1;
              })(),
            );
          }

          if (needsPhotos && opts.maxPhotos > 0) {
            const shots = (shiki?.screenshots ?? []).slice(0, opts.maxPhotos);
            shots.forEach((shot, sortOrder) => {
              if (!shot.original) return;
              const src = absoluteShikiUrl(shot.original);
              const filename = uniqueFilename(
                `photo-shiki${entry.target_id}`,
                src,
              );
              imageJobs.push(
                (async () => {
                  const publicPath = await downloadImage(src, filename);
                  if (!publicPath) return;
                  await prisma.mediaPhoto.create({
                    data: {
                      mediaId,
                      url: publicPath,
                      sortOrder,
                    },
                  });
                  stats.photosDownloaded += 1;
                  if (media) media.photos = [{ id: '1' }];
                })(),
              );
            });
          }

          if (imageJobs.length > 0) {
            await Promise.all(imageJobs);
          }
        }

        if (!mediaId || opts.dryRun) {
          continue;
        }

        const existingItem = await prisma.item.findFirst({
          where: { categoryId: animeCategory.id, mediaId },
        });
        const itemData = {
          title,
          status: mapStatus(entry.status),
          rating: mapRating(entry.score),
          notes: entry.text?.trim() ?? '',
          year: year ?? undefined,
          completedAt:
            mapStatus(entry.status) === ItemStatus.DONE ? new Date() : null,
        };

        if (existingItem) {
          await prisma.item.update({
            where: { id: existingItem.id },
            data: itemData,
          });
          stats.itemsUpdated += 1;
        } else {
          await prisma.item.create({
            data: {
              categoryId: animeCategory.id,
              mediaId,
              ...itemData,
            },
          });
          stats.itemsCreated += 1;
        }

        if ((i + 1) % 25 === 0 || i === entries.length - 1) {
          console.log(
            `${label} | media +${stats.mediaCreated}/skip ${stats.mediaSkipped} | items +${stats.itemsCreated}/upd ${stats.itemsUpdated} | covers ${stats.coversDownloaded} photos ${stats.photosDownloaded} | fails ${stats.failures}`,
          );
        }
      } catch (err) {
        stats.failures += 1;
        console.error(`${label} FAILED`, err);
      }
    }

    const animeMediaCount = await prisma.media.count({
      where: { type: MediaType.ANIME },
    });
    const shelfItemCount = await prisma.item.count({
      where: { categoryId: animeCategory.id },
    });
    const withCover = await prisma.media.count({
      where: { type: MediaType.ANIME, coverUrl: { not: null } },
    });

    console.log('\n=== Import complete ===');
    console.log(JSON.stringify(stats, null, 2));
    console.log(`DB ANIME media: ${animeMediaCount} (with cover: ${withCover})`);
    console.log(`DB items on Anime shelf: ${shelfItemCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
