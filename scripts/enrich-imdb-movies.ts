/**
 * Enrich existing IMDb-imported MOVIE media:
 *   - Strip synthetic metadata descriptions (rating/genres/Source: IMDb tt…)
 *   - Fetch real plot + cover (and TMDB gallery when TMDB_API_KEY is set)
 *
 * Parses `tt########` from existing descriptions (kept in
 * scripts/.cache/imdb/tconst-by-media.json so ids survive description clears).
 *
 * Sources: OMDb / TMDB if keyed in .env; otherwise IMDb suggestion (covers)
 * and Wikipedia (plots + cover fallback). See lib/imdb-media.ts.
 *
 * Usage (from backend/):
 *   bun run import:imdb-movie-covers -- --strip-only
 *   bun run import:imdb-movie-covers -- --covers-only
 *   bun run import:imdb-movie-covers -- --plots-only
 *   bun run import:imdb-movie-covers
 *   bun run import:imdb-movie-covers -- --limit 50
 *   bun run import:imdb-movie-covers -- --dry-run --limit 20
 *
 * Optional env: OMDB_API_KEY, TMDB_API_KEY,
 *   IMDB_ENRICH_OPENSEARCH=1, IMDB_ENRICH_WIKIDATA=1
 *
 * Progress / resume: scripts/.cache/imdb/enrich-progress.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { MediaType, PrismaClient } from '../generated/prisma/index.js';
import {
  describeAvailableSources,
  downloadCoverFromRemote,
  downloadGalleryFromRemotes,
  fetchMovieEnrichment,
  isSyntheticImdbDescription,
  parseImdbIdFromDescription,
} from './lib/imdb-media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

const CACHE_DIR = path.join(BACKEND_ROOT, 'scripts', '.cache', 'imdb');
const UPLOAD_DIR = path.join(BACKEND_ROOT, 'uploads', 'media');
const PROGRESS_PATH = path.join(CACHE_DIR, 'enrich-progress.json');
const TCONST_MAP_PATH = path.join(CACHE_DIR, 'tconst-by-media.json');

type CliOptions = {
  limit: number | null;
  skipImages: boolean;
  skipAlreadyHasCover: boolean;
  forcePlot: boolean;
  dryRun: boolean;
  maxPhotos: number;
  coversOnly: boolean;
  plotsOnly: boolean;
  stripOnly: boolean;
};

type ProgressFile = {
  processedIds: string[];
  updatedAt: string;
  stats: Record<string, number>;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: null,
    skipImages: false,
    skipAlreadyHasCover: false,
    forcePlot: false,
    dryRun: false,
    maxPhotos: 6,
    coversOnly: false,
    plotsOnly: false,
    stripOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--skip-images') opts.skipImages = true;
    else if (arg === '--skip-already-has-cover') opts.skipAlreadyHasCover = true;
    else if (arg === '--force-plot') opts.forcePlot = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--max-photos') opts.maxPhotos = Number(argv[++i]);
    else if (arg === '--covers-only') opts.coversOnly = true;
    else if (arg === '--plots-only') opts.plotsOnly = true;
    else if (arg === '--strip-only') opts.stripOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`See file header for usage.`);
      process.exit(0);
    }
  }

  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 0)) {
    throw new Error(`Invalid --limit: ${opts.limit}`);
  }
  return opts;
}

async function loadProgress(): Promise<Set<string>> {
  try {
    const raw = await readFile(PROGRESS_PATH, 'utf8');
    const data = JSON.parse(raw) as ProgressFile;
    return new Set(data.processedIds ?? []);
  } catch {
    return new Set();
  }
}

async function saveProgress(
  processedIds: Set<string>,
  stats: Record<string, number>,
) {
  const payload: ProgressFile = {
    processedIds: [...processedIds],
    updatedAt: new Date().toISOString(),
    stats,
  };
  await writeFile(PROGRESS_PATH, JSON.stringify(payload));
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
  await writeFile(TCONST_MAP_PATH, JSON.stringify(map));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });

  const hasTmdb = Boolean(process.env.TMDB_API_KEY?.trim());
  const mode = opts.stripOnly
    ? 'strip-only'
    : opts.coversOnly
      ? 'covers-only'
      : opts.plotsOnly
        ? 'plots-only'
        : 'covers+plots';

  console.log(
    `IMDb movie enrich [${mode}] → sources: ${describeAvailableSources()}` +
      (opts.limit != null ? `, limit ${opts.limit}` : '') +
      (opts.dryRun ? ', dry-run' : ''),
  );
  if (!process.env.OMDB_API_KEY?.trim() && !hasTmdb) {
    console.log(
      'Note: no OMDB_API_KEY / TMDB_API_KEY — covers via IMDb suggestion; plots via Wikipedia. Gallery needs TMDB_API_KEY.',
    );
  }

  const prisma = new PrismaClient();
  const processed = await loadProgress();
  const tconstByMedia = await loadTconstMap();
  const stats = {
    scanned: 0,
    withImdbId: 0,
    skippedNoId: 0,
    skippedDone: 0,
    descriptionsCleared: 0,
    descriptionsSet: 0,
    coversDownloaded: 0,
    galleriesSet: 0,
    failures: 0,
  };

  try {
    const movies = await prisma.media.findMany({
      where: { type: MediaType.MOVIE },
      select: {
        id: true,
        title: true,
        year: true,
        coverUrl: true,
        description: true,
        photos: { select: { id: true }, take: 1 },
      },
      orderBy: { title: 'asc' },
    });

    // Persist imdb ids from synthetic descriptions, then strip in one SQL pass.
    for (const m of movies) {
      stats.scanned += 1;
      const imdbId =
        parseImdbIdFromDescription(m.description) ??
        tconstByMedia[m.id] ??
        null;
      if (imdbId) {
        tconstByMedia[m.id] = imdbId;
        stats.withImdbId += 1;
      }
    }

    if (!opts.dryRun) await saveTconstMap(tconstByMedia);

    if (!opts.plotsOnly) {
      if (opts.dryRun) {
        const wouldStrip = movies.filter((m) =>
          isSyntheticImdbDescription(m.description),
        ).length;
        console.log(`Would strip ${wouldStrip} synthetic descriptions`);
        stats.descriptionsCleared = wouldStrip;
      } else {
        const result = await prisma.$executeRawUnsafe(`
          UPDATE Media
          SET description = ''
          WHERE type = 'MOVIE'
            AND description LIKE 'IMDb %Source: IMDb tt%'
        `);
        stats.descriptionsCleared = Number(result) || 0;
        console.log(`Stripped ${stats.descriptionsCleared} synthetic descriptions`);
        // Refresh in-memory descriptions after bulk strip.
        for (const m of movies) {
          if (isSyntheticImdbDescription(m.description)) m.description = '';
        }
      }
    }

    if (opts.stripOnly) {
      console.log(
        `\n=== Strip complete === cleared ${stats.descriptionsCleared}, tconst map ${Object.keys(tconstByMedia).length}`,
      );
      return;
    }

    type WorkItem = (typeof movies)[number] & { imdbId: string };
    const work: WorkItem[] = [];

    for (const m of movies) {
      const imdbId = tconstByMedia[m.id];
      if (!imdbId) {
        stats.skippedNoId += 1;
        continue;
      }

      const needCover =
        !opts.plotsOnly && !opts.skipImages && !m.coverUrl;
      const needPlot =
        !opts.coversOnly &&
        (opts.forcePlot || !m.description?.trim());
      const needGallery =
        !opts.coversOnly &&
        !opts.plotsOnly &&
        !opts.skipImages &&
        hasTmdb &&
        opts.maxPhotos > 0 &&
        m.photos.length === 0;

      if (!needCover && !needPlot && !needGallery) {
        stats.skippedDone += 1;
        continue;
      }

      if (opts.skipAlreadyHasCover && m.coverUrl && !needPlot && !needGallery) {
        stats.skippedDone += 1;
        continue;
      }

      work.push({ ...m, imdbId });
    }

    const limited =
      opts.limit != null ? work.slice(0, opts.limit) : work;
    console.log(
      `Network candidates: ${limited.length} (of ${work.length} pending, ${movies.length} MOVIE total)`,
    );

    for (let i = 0; i < limited.length; i++) {
      const movie = limited[i]!;
      const label = `[${i + 1}/${limited.length}] ${movie.title} (${movie.year ?? '?'}) ${movie.imdbId}`;
      const needCover =
        !opts.plotsOnly && !opts.skipImages && !movie.coverUrl;
      const needPlot =
        !opts.coversOnly &&
        (opts.forcePlot || !movie.description?.trim());
      const needGallery =
        !opts.coversOnly &&
        !opts.plotsOnly &&
        !opts.skipImages &&
        hasTmdb &&
        opts.maxPhotos > 0 &&
        movie.photos.length === 0;

      try {
        if (opts.dryRun) {
          console.log(
            `${label} → would enrich cover=${needCover} plot=${needPlot} gallery=${needGallery}`,
          );
          continue;
        }

        tconstByMedia[movie.id] = movie.imdbId;

        let plot: string | null = null;
        let coverPublic: string | null = null;
        let galleryPublic: string[] = [];
        let coverSource: string | null = null;
        let plotSource: string | null = null;

        if (needCover || needPlot || needGallery) {
          const enrichment = await fetchMovieEnrichment(movie.imdbId, {
            needCover,
            needPlot,
            needGallery,
            title: movie.title,
            year: movie.year,
          });
          plot = enrichment.plot;
          coverSource = enrichment.source.cover;
          plotSource = enrichment.source.plot;

          if (needCover && enrichment.remoteCoverUrl) {
            coverPublic = await downloadCoverFromRemote(
              enrichment.remoteCoverUrl,
              movie.imdbId,
              UPLOAD_DIR,
            );
          }

          if (needGallery && enrichment.galleryUrls.length > 0) {
            galleryPublic = await downloadGalleryFromRemotes(
              enrichment.galleryUrls.slice(0, opts.maxPhotos),
              movie.imdbId,
              UPLOAD_DIR,
            );
          }
        }

        const data: { description?: string; coverUrl?: string } = {};

        if (needPlot && plot?.trim()) {
          data.description = plot.trim();
          stats.descriptionsSet += 1;
        }

        if (coverPublic) {
          data.coverUrl = coverPublic;
          stats.coversDownloaded += 1;
        }

        if (Object.keys(data).length > 0) {
          await prisma.media.update({
            where: { id: movie.id },
            data,
          });
          if (data.description != null) movie.description = data.description;
          if (data.coverUrl) movie.coverUrl = data.coverUrl;
        }

        if (galleryPublic.length > 0) {
          await prisma.mediaPhoto.createMany({
            data: galleryPublic.map((url, sortOrder) => ({
              mediaId: movie.id,
              url,
              sortOrder,
            })),
          });
          stats.galleriesSet += 1;
        }

        processed.add(movie.id);

        if ((i + 1) % 50 === 0 || i === limited.length - 1) {
          console.log(
            `${label} | cover=${coverSource ?? '-'} plot=${plotSource ?? '-'} | ` +
              `covers ${stats.coversDownloaded} plots ${stats.descriptionsSet} | fails ${stats.failures}`,
          );
          await saveProgress(processed, stats);
          await saveTconstMap(tconstByMedia);
        }
      } catch (err) {
        stats.failures += 1;
        console.error(`${label} FAILED`, err);
      }
    }

    if (!opts.dryRun) {
      await saveProgress(processed, stats);
      await saveTconstMap(tconstByMedia);
    }

    const movieCount = await prisma.media.count({
      where: { type: MediaType.MOVIE },
    });
    const withCover = await prisma.media.count({
      where: { type: MediaType.MOVIE, coverUrl: { not: null } },
    });
    const stillSynthetic = await prisma.media.count({
      where: {
        type: MediaType.MOVIE,
        description: { contains: 'Source: IMDb tt' },
      },
    });

    console.log('\n=== IMDb movie enrich complete ===');
    console.log(JSON.stringify(stats, null, 2));
    console.log(
      `DB MOVIE media: ${movieCount} (with cover: ${withCover}, still synthetic desc: ${stillSynthetic})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
