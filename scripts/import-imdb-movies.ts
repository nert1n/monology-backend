/**
 * Import feature films from IMDb non-commercial datasets into Media (type=MOVIE).
 * Catalog only — does NOT create user shelf Items.
 *
 * Source (official dumps, not HTML scraping):
 *   https://datasets.imdbws.com/title.basics.tsv.gz
 *   https://datasets.imdbws.com/title.ratings.tsv.gz
 * License notes: https://developer.imdb.com/non-commercial-datasets/
 *
 * Default filters (keep the catalog usable — not every obscure title):
 *   - titleType = movie (feature films; excludes tvMovie, short, etc.)
 *   - isAdult = 0
 *   - startYear present
 *   - numVotes >= 10_000 (popularity proxy; override with --min-votes)
 *   - ordered by numVotes desc so --limit prefers well-known titles
 *
 * Dedup: existing Media with type=MOVIE + same title + year (case-insensitive title).
 *
 * Description: real plot when fetchable (OMDb / Wikipedia); otherwise empty.
 *   Does NOT write rating/genres/Source metadata into description.
 *   IMDb ids are recorded in scripts/.cache/imdb/tconst-by-media.json for enrichment.
 *
 * Covers: IMDb dumps have no posters. Fetched via OMDb / TMDB / IMDb suggestion /
 *   Wikipedia when not --skip-images. See scripts/lib/imdb-media.ts.
 *
 * Usage (from backend/):
 *   bun run import:imdb-movies
 *   bun run import:imdb-movies -- --limit 50
 *   bun run import:imdb-movies -- --min-votes 25000 --limit 200
 *   bun run import:imdb-movies -- --min-rating 7.5 --limit 100
 *   bun run import:imdb-movies -- --skip-images
 *   bun run import:imdb-movies -- --dry-run --limit 20
 *   bun run import:imdb-movies -- --refresh-datasets
 *
 * Enrich existing rows (covers + plots, strip old synthetic descriptions):
 *   bun run import:imdb-movie-covers
 *
 * Full popular set (no limit, default min-votes 10k): ~10–20k rows; run overnight-friendly.
 * Datasets cache: scripts/.cache/imdb/
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { config as loadEnv } from 'dotenv';
import { MediaType, PrismaClient } from '../generated/prisma/index.js';
import {
  describeAvailableSources,
  downloadCoverFromRemote,
  downloadGalleryFromRemotes,
  fetchMovieEnrichment,
} from './lib/imdb-media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const IMDB_ORIGIN = 'https://datasets.imdbws.com';
const BASICS_URL = `${IMDB_ORIGIN}/title.basics.tsv.gz`;
const RATINGS_URL = `${IMDB_ORIGIN}/title.ratings.tsv.gz`;
const USER_AGENT =
  'monology-list-import/1.0 (local seed; IMDb non-commercial datasets)';
const CACHE_DIR = path.join(BACKEND_ROOT, 'scripts', '.cache', 'imdb');
const UPLOAD_DIR = path.join(BACKEND_ROOT, 'uploads', 'media');
const TCONST_MAP_PATH = path.join(CACHE_DIR, 'tconst-by-media.json');
const DEFAULT_MIN_VOTES = 10_000;

type CliOptions = {
  limit: number | null;
  minVotes: number;
  minRating: number | null;
  skipImages: boolean;
  dryRun: boolean;
  refreshDatasets: boolean;
  includeAdult: boolean;
  maxPhotos: number;
};

type RatingRow = {
  averageRating: number;
  numVotes: number;
};

type MovieCandidate = {
  tconst: string;
  title: string;
  year: number;
  genres: string[];
  averageRating: number;
  numVotes: number;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: null,
    minVotes: DEFAULT_MIN_VOTES,
    minRating: null,
    skipImages: false,
    dryRun: false,
    refreshDatasets: false,
    includeAdult: false,
    maxPhotos: 6,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--min-votes') opts.minVotes = Number(argv[++i]);
    else if (arg === '--min-rating') opts.minRating = Number(argv[++i]);
    else if (arg === '--skip-images') opts.skipImages = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--refresh-datasets') opts.refreshDatasets = true;
    else if (arg === '--include-adult') opts.includeAdult = true;
    else if (arg === '--max-photos') opts.maxPhotos = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`See file header for usage.`);
      process.exit(0);
    }
  }

  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 0)) {
    throw new Error(`Invalid --limit: ${opts.limit}`);
  }
  if (!Number.isFinite(opts.minVotes) || opts.minVotes < 0) {
    throw new Error(`Invalid --min-votes: ${opts.minVotes}`);
  }
  if (
    opts.minRating != null &&
    (!Number.isFinite(opts.minRating) ||
      opts.minRating < 0 ||
      opts.minRating > 10)
  ) {
    throw new Error(`Invalid --min-rating: ${opts.minRating}`);
  }
  return opts;
}

function dedupeKey(title: string, year: number | null): string {
  return `${title.toLowerCase()}\0${year ?? ''}`;
}

async function loadTconstMap(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(TCONST_MAP_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveTconstMap(map: Record<string, string>) {
  await writeFile(TCONST_MAP_PATH, JSON.stringify(map, null, 0));
}

async function ensureDataset(
  filename: string,
  url: string,
  refresh: boolean,
): Promise<string> {
  const dest = path.join(CACHE_DIR, filename);
  if (!refresh) {
    try {
      const info = await stat(dest);
      if (info.size > 0) {
        console.log(`Using cached ${filename} (${(info.size / 1e6).toFixed(1)} MB)`);
        return dest;
      }
    } catch {
      // miss
    }
  }

  console.log(`Downloading ${url} …`);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }

  const tmp = `${dest}.partial`;
  const nodeStream = Readable.fromWeb(
    res.body as import('node:stream/web').ReadableStream,
  );
  await pipeline(nodeStream, createWriteStream(tmp));
  await rename(tmp, dest);
  const info = await stat(dest);
  console.log(`Saved ${filename} (${(info.size / 1e6).toFixed(1)} MB)`);
  return dest;
}

async function* readTsvGz(filePath: string): AsyncGenerator<string[]> {
  const rl = createInterface({
    input: createReadStream(filePath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }
    if (!line) continue;
    yield line.split('\t');
  }
}

async function loadRatings(
  ratingsPath: string,
  minVotes: number,
  minRating: number | null,
): Promise<Map<string, RatingRow>> {
  const map = new Map<string, RatingRow>();
  let scanned = 0;
  for await (const cols of readTsvGz(ratingsPath)) {
    scanned += 1;
    if (cols.length < 3) continue;
    const [tconst, ratingRaw, votesRaw] = cols;
    const numVotes = Number(votesRaw);
    const averageRating = Number(ratingRaw);
    if (!Number.isFinite(numVotes) || numVotes < minVotes) continue;
    if (!Number.isFinite(averageRating)) continue;
    if (minRating != null && averageRating < minRating) continue;
    map.set(tconst, { averageRating, numVotes });
    if (scanned % 500_000 === 0) {
      console.log(`  ratings scanned ${scanned}, kept ${map.size}`);
    }
  }
  console.log(`Ratings: scanned ${scanned}, kept ${map.size} (minVotes≥${minVotes})`);
  return map;
}

async function collectMovies(
  basicsPath: string,
  ratings: Map<string, RatingRow>,
  opts: CliOptions,
): Promise<MovieCandidate[]> {
  const out: MovieCandidate[] = [];
  let scanned = 0;

  for await (const cols of readTsvGz(basicsPath)) {
    scanned += 1;
    if (cols.length < 9) continue;
    const [
      tconst,
      titleType,
      primaryTitle,
      _originalTitle,
      isAdult,
      startYearRaw,
      _endYear,
      _runtime,
      genresRaw,
    ] = cols;

    if (titleType !== 'movie') continue;
    if (!opts.includeAdult && isAdult === '1') continue;
    if (startYearRaw === '\\N' || !startYearRaw) continue;
    const year = Number(startYearRaw);
    if (!Number.isFinite(year)) continue;

    const rating = ratings.get(tconst);
    if (!rating) continue;

    const title = primaryTitle?.trim();
    if (!title) continue;

    const genres =
      genresRaw && genresRaw !== '\\N'
        ? genresRaw.split(',').map((g) => g.trim()).filter(Boolean)
        : [];

    out.push({
      tconst,
      title,
      year,
      genres,
      averageRating: rating.averageRating,
      numVotes: rating.numVotes,
    });

    if (scanned % 500_000 === 0) {
      console.log(`  basics scanned ${scanned}, movies matched ${out.length}`);
    }
  }

  out.sort((a, b) => b.numVotes - a.numVotes || b.averageRating - a.averageRating);
  console.log(
    `Basics: scanned ${scanned}, matched ${out.length} feature films` +
      (opts.limit != null ? ` (will import up to ${opts.limit})` : ''),
  );
  return opts.limit != null ? out.slice(0, opts.limit) : out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });

  const hasTmdb = Boolean(process.env.TMDB_API_KEY?.trim());
  const canFetchMedia = !opts.skipImages;

  console.log(
    `IMDb movies import → minVotes≥${opts.minVotes}` +
      (opts.minRating != null ? `, minRating≥${opts.minRating}` : '') +
      (opts.limit != null ? `, limit ${opts.limit}` : ', no limit') +
      (opts.dryRun ? ', dry-run' : '') +
      (opts.skipImages ? ', skip-images' : ''),
  );
  console.log(`Media enrich sources: ${describeAvailableSources()}`);
  if (!process.env.OMDB_API_KEY?.trim() && !hasTmdb) {
    console.log(
      'Covers/plots: free path (IMDb suggestion + Wikipedia). Set OMDB_API_KEY or TMDB_API_KEY for richer data; gallery needs TMDB.',
    );
  }

  const ratingsPath = await ensureDataset(
    'title.ratings.tsv.gz',
    RATINGS_URL,
    opts.refreshDatasets,
  );
  const basicsPath = await ensureDataset(
    'title.basics.tsv.gz',
    BASICS_URL,
    opts.refreshDatasets,
  );

  const ratings = await loadRatings(ratingsPath, opts.minVotes, opts.minRating);
  const movies = await collectMovies(basicsPath, ratings, opts);

  const prisma = new PrismaClient();
  const tconstByMedia = await loadTconstMap();
  const stats = {
    candidates: movies.length,
    mediaCreated: 0,
    mediaSkipped: 0,
    plotsSet: 0,
    coversDownloaded: 0,
    galleriesSet: 0,
    failures: 0,
  };

  try {
    const existingMedia = await prisma.media.findMany({
      where: { type: MediaType.MOVIE },
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

    for (let i = 0; i < movies.length; i++) {
      const movie = movies[i]!;
      const label = `[${i + 1}/${movies.length}] ${movie.title} (${movie.year})`;
      const key = dedupeKey(movie.title, movie.year);

      try {
        let media = mediaByKey.get(key);
        if (!media) {
          const found = await prisma.media.findFirst({
            where: {
              type: MediaType.MOVIE,
              title: movie.title,
              year: movie.year,
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

        if (!media) {
          if (opts.dryRun) {
            console.log(`${label} → would create`);
            stats.mediaCreated += 1;
            continue;
          }
          const created = await prisma.media.create({
            data: {
              type: MediaType.MOVIE,
              title: movie.title,
              description: '',
              year: movie.year,
            },
          });
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
        }

        if (!opts.dryRun && media) {
          tconstByMedia[media.id] = movie.tconst;
        }

        const needCover = canFetchMedia && !opts.dryRun && media && !media.coverUrl;
        const needPlot =
          canFetchMedia && !opts.dryRun && media && !media.description?.trim();
        const needGallery =
          canFetchMedia &&
          !opts.dryRun &&
          media &&
          hasTmdb &&
          opts.maxPhotos > 0 &&
          media.photos.length === 0;

        if (media && (needCover || needPlot || needGallery)) {
          const enrichment = await fetchMovieEnrichment(movie.tconst, {
            needCover: Boolean(needCover),
            needPlot: Boolean(needPlot),
            needGallery: Boolean(needGallery),
            title: movie.title,
            year: movie.year,
          });

          const data: { description?: string; coverUrl?: string } = {};

          if (needPlot && enrichment.plot) {
            data.description = enrichment.plot;
            media.description = enrichment.plot;
            stats.plotsSet += 1;
          }

          if (needCover && enrichment.remoteCoverUrl) {
            const publicPath = await downloadCoverFromRemote(
              enrichment.remoteCoverUrl,
              movie.tconst,
              UPLOAD_DIR,
            );
            if (publicPath) {
              data.coverUrl = publicPath;
              media.coverUrl = publicPath;
              stats.coversDownloaded += 1;
            }
          }

          if (Object.keys(data).length > 0) {
            await prisma.media.update({
              where: { id: media.id },
              data,
            });
          }

          if (needGallery && enrichment.galleryUrls.length > 0) {
            const galleryPublic = await downloadGalleryFromRemotes(
              enrichment.galleryUrls.slice(0, opts.maxPhotos),
              movie.tconst,
              UPLOAD_DIR,
            );
            if (galleryPublic.length > 0) {
              await prisma.mediaPhoto.createMany({
                data: galleryPublic.map((url, sortOrder) => ({
                  mediaId: media.id,
                  url,
                  sortOrder,
                })),
              });
              media.photos = galleryPublic.map(() => ({ id: 'x' }));
              stats.galleriesSet += 1;
            }
          }
        }

        if ((i + 1) % 50 === 0 || i === movies.length - 1) {
          console.log(
            `${label} | +${stats.mediaCreated}/skip ${stats.mediaSkipped} | covers ${stats.coversDownloaded} plots ${stats.plotsSet} | fails ${stats.failures}`,
          );
          if (!opts.dryRun) await saveTconstMap(tconstByMedia);
        }
      } catch (err) {
        stats.failures += 1;
        console.error(`${label} FAILED`, err);
      }
    }

    if (!opts.dryRun) await saveTconstMap(tconstByMedia);

    const movieCount = await prisma.media.count({
      where: { type: MediaType.MOVIE },
    });
    const withCover = await prisma.media.count({
      where: { type: MediaType.MOVIE, coverUrl: { not: null } },
    });

    console.log('\n=== IMDb movies import complete ===');
    console.log(JSON.stringify(stats, null, 2));
    console.log(`DB MOVIE media: ${movieCount} (with cover: ${withCover})`);
    console.log(`tconst map: ${TCONST_MAP_PATH} (${Object.keys(tconstByMedia).length} entries)`);
    console.log(`\nRe-run / enrich:`);
    console.log(`  bun run import:imdb-movies -- --limit 100`);
    console.log(`  bun run import:imdb-movie-covers`);
  } finally {
    await prisma.$disconnect();
    try {
      await unlink(path.join(CACHE_DIR, 'title.basics.tsv.gz.partial'));
    } catch {
      // ignore
    }
    try {
      await unlink(path.join(CACHE_DIR, 'title.ratings.tsv.gz.partial'));
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
