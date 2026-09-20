/**
 * Shared helpers for IMDb movie import / cover+plot enrichment.
 *
 * Cover sources (first hit wins):
 *   1. OMDb (OMDB_API_KEY) — Poster
 *   2. TMDB find-by-imdb (TMDB_API_KEY) — poster_path + optional backdrops
 *   3. IMDb suggestion JSON (no key) — imageUrl
 *   4. Wikipedia page summary thumbnail (via Wikidata P345 → enwiki)
 *
 * Plot / description sources (first hit wins):
 *   1. OMDb Plot
 *   2. Wikipedia REST summary extract (via Wikidata)
 *
 * Synthetic import descriptions look like:
 *   "IMDb 6.1/10 (10,001 votes). Genres: Comedy, Family. Source: IMDb tt0837156."
 */

import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export const USER_AGENT =
  'monology-list-import/1.0 (local seed; non-commercial; contact: local-dev)';
export const MEDIA_PUBLIC_PREFIX = '/uploads/media';

export const OMDB_GAP_MS = 250;
export const TMDB_GAP_MS = 250;
export const IMDB_SUGGEST_GAP_MS = 100;
export const WIKI_GAP_MS = 80;
export const WIKIDATA_GAP_MS = 2500;

/** Matches the stuffed metadata line written by the original import. */
export const SYNTHETIC_IMDB_DESCRIPTION_RE =
  /^IMDb\s+\d+(?:\.\d+)?\/10\s+\([\d,]+ votes\)\.(?:\s+Genres:\s+.+\.)?\s+Source:\s+IMDb\s+(tt\d+)\.?$/i;

export const IMDB_ID_IN_TEXT_RE = /\b(tt\d{7,})\b/i;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSyntheticImdbDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  return SYNTHETIC_IMDB_DESCRIPTION_RE.test(description.trim());
}

export function parseImdbIdFromDescription(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  const trimmed = description.trim();
  const synthetic = SYNTHETIC_IMDB_DESCRIPTION_RE.exec(trimmed);
  if (synthetic?.[1]) return synthetic[1].toLowerCase();
  const loose = IMDB_ID_IN_TEXT_RE.exec(trimmed);
  return loose?.[1]?.toLowerCase() ?? null;
}

export function extFromUrl(url: string): string {
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

export async function downloadImage(
  url: string,
  filename: string,
  uploadDir: string,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn(`  ! image HTTP ${res.status}: ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;
    await writeFile(path.join(uploadDir, filename), buf);
    return `${MEDIA_PUBLIC_PREFIX}/${filename}`;
  } catch (err) {
    console.warn(`  ! image download failed: ${url}`, err);
    return null;
  }
}

export type EnrichmentResult = {
  /** Remote poster URL (not yet saved under /uploads). */
  remoteCoverUrl: string | null;
  plot: string | null;
  /** Remote gallery/backdrop URLs (TMDB when keyed). */
  galleryUrls: string[];
  source: {
    cover: string | null;
    plot: string | null;
  };
};

type OmdbPayload = {
  Response?: string;
  Poster?: string;
  Plot?: string;
  Error?: string;
};

type TmdbFindPayload = {
  movie_results?: Array<{
    poster_path?: string | null;
    backdrop_path?: string | null;
    id?: number;
  }>;
};

type TmdbImagesPayload = {
  backdrops?: Array<{ file_path?: string | null }>;
};

type ImdbSuggestPayload = {
  d?: Array<{
    id?: string;
    i?: { imageUrl?: string };
  }>;
};

/**
 * Resolve enwiki titles for many IMDb ids via one Wikidata SPARQL VALUES query.
 * Returns Map<ttId, wikipediaTitleCanonical> (spaces as underscores ok for REST).
 */
export async function resolveWikipediaTitlesByImdbIds(
  imdbIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (imdbIds.length === 0) return out;

  const values = imdbIds.map((id) => `"${id.replace(/"/g, '')}"`).join(' ');
  const query = `
SELECT ?imdb ?enwiki WHERE {
  VALUES ?imdb { ${values} }
  ?item wdt:P345 ?imdb .
  OPTIONAL {
    ?enwiki schema:about ?item ;
            schema:isPartOf <https://en.wikipedia.org/> .
  }
}`;

  await sleep(WIKIDATA_GAP_MS);
  const url = new URL('https://query.wikidata.org/sparql');
  url.searchParams.set('format', 'json');
  url.searchParams.set('query', query);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      console.warn(`  ! Wikidata HTTP ${res.status}`);
      return out;
    }
    const data = (await res.json()) as {
      results?: {
        bindings?: Array<{
          imdb?: { value?: string };
          enwiki?: { value?: string };
        }>;
      };
    };
    for (const row of data.results?.bindings ?? []) {
      const imdb = row.imdb?.value?.toLowerCase();
      const wikiUrl = row.enwiki?.value;
      if (!imdb || !wikiUrl) continue;
      try {
        const title = decodeURIComponent(
          new URL(wikiUrl).pathname.replace(/^\/wiki\//, ''),
        );
        if (title) out.set(imdb, title);
      } catch {
        // ignore bad urls
      }
    }
  } catch (err) {
    console.warn('  ! Wikidata query failed:', err);
  }
  return out;
}

export async function fetchWikipediaSummary(title: string): Promise<{
  extract: string | null;
  thumbnailUrl: string | null;
} | null> {
  await sleep(WIKI_GAP_MS);
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as {
      type?: string;
      extract?: string;
      originalimage?: { source?: string };
      thumbnail?: { source?: string };
    };
    if (data.type === 'disambiguation') return null;
    const extract = data.extract?.trim() || null;
    const thumbnailUrl =
      data.originalimage?.source?.trim() ||
      data.thumbnail?.source?.trim() ||
      null;
    return { extract, thumbnailUrl };
  } catch (err) {
    console.warn(`  ! Wikipedia summary failed for ${title}:`, err);
    return null;
  }
}

/** Try common Wikipedia title patterns for a film. */
export async function fetchWikipediaForMovie(opts: {
  title: string;
  year?: number | null;
  wikipediaTitleHint?: string | null;
  imdbId?: string | null;
}): Promise<{
  extract: string | null;
  thumbnailUrl: string | null;
  matchedTitle: string | null;
} | null> {
  const candidates: string[] = [];
  if (opts.wikipediaTitleHint) candidates.push(opts.wikipediaTitleHint);
  const clean = opts.title.replace(/^#+/, '').trim();
  if (clean) {
    candidates.push(clean);
    if (opts.year != null) {
      candidates.push(`${clean} (${opts.year} film)`);
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = await fetchWikipediaSummary(candidate);
    if (summary?.extract) {
      return { ...summary, matchedTitle: candidate };
    }
  }

  // OpenSearch fallback (optional — slower; enable with IMDB_ENRICH_OPENSEARCH=1).
  if (clean && process.env.IMDB_ENRICH_OPENSEARCH === '1') {
    const q =
      opts.year != null ? `${clean} ${opts.year} film` : `${clean} film`;
    const searched = await wikipediaOpenSearch(q);
    for (const title of searched) {
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const summary = await fetchWikipediaSummary(title);
      if (summary?.extract) {
        return { ...summary, matchedTitle: title };
      }
    }
  }

  if (opts.imdbId && process.env.IMDB_ENRICH_WIKIDATA === '1') {
    const map = await resolveWikipediaTitlesByImdbIds([opts.imdbId]);
    const wikiTitle = map.get(opts.imdbId.toLowerCase());
    if (wikiTitle && !seen.has(wikiTitle.toLowerCase())) {
      const summary = await fetchWikipediaSummary(wikiTitle);
      if (summary) {
        return { ...summary, matchedTitle: wikiTitle };
      }
    }
  }

  return null;
}

async function wikipediaOpenSearch(query: string): Promise<string[]> {
  await sleep(WIKI_GAP_MS);
  const url =
    `https://en.wikipedia.org/w/api.php?action=opensearch` +
    `&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
    return (data[1] as unknown[]).filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    );
  } catch {
    return [];
  }
}

async function fetchOmdb(tconst: string): Promise<OmdbPayload | null> {
  const omdbKey = process.env.OMDB_API_KEY?.trim();
  if (!omdbKey) return null;
  await sleep(OMDB_GAP_MS);
  const url =
    `https://www.omdbapi.com/?i=${encodeURIComponent(tconst)}` +
    `&plot=full&apikey=${encodeURIComponent(omdbKey)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as OmdbPayload;
    if (data.Response === 'False') return null;
    return data;
  } catch (err) {
    console.warn(`  ! OMDb failed for ${tconst}:`, err);
    return null;
  }
}

async function fetchTmdbByImdb(tconst: string): Promise<{
  posterUrl: string | null;
  galleryUrls: string[];
} | null> {
  const tmdbKey = process.env.TMDB_API_KEY?.trim();
  if (!tmdbKey) return null;
  await sleep(TMDB_GAP_MS);
  try {
    const findUrl =
      `https://api.themoviedb.org/3/find/${encodeURIComponent(tconst)}` +
      `?external_source=imdb_id&api_key=${encodeURIComponent(tmdbKey)}`;
    const res = await fetch(findUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as TmdbFindPayload;
    const movie = data.movie_results?.[0];
    if (!movie) return { posterUrl: null, galleryUrls: [] };

    const posterUrl = movie.poster_path
      ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
      : null;

    const galleryUrls: string[] = [];
    if (movie.id != null) {
      await sleep(TMDB_GAP_MS);
      const imgUrl =
        `https://api.themoviedb.org/3/movie/${movie.id}/images` +
        `?api_key=${encodeURIComponent(tmdbKey)}`;
      const imgRes = await fetch(imgUrl, {
        headers: { Accept: 'application/json' },
      });
      if (imgRes.ok) {
        const images = (await imgRes.json()) as TmdbImagesPayload;
        for (const shot of images.backdrops?.slice(0, 6) ?? []) {
          if (shot.file_path) {
            galleryUrls.push(
              `https://image.tmdb.org/t/p/w780${shot.file_path}`,
            );
          }
        }
      }
    } else if (movie.backdrop_path) {
      galleryUrls.push(
        `https://image.tmdb.org/t/p/w780${movie.backdrop_path}`,
      );
    }

    return { posterUrl, galleryUrls };
  } catch (err) {
    console.warn(`  ! TMDB failed for ${tconst}:`, err);
    return null;
  }
}

async function fetchImdbSuggestionPoster(
  tconst: string,
): Promise<string | null> {
  await sleep(IMDB_SUGGEST_GAP_MS);
  // Suggestion index uses first character of the id after "tt" sometimes;
  // the /t/{fullId}.json form works for full tconst.
  const url = `https://v2.sg.media-imdb.com/suggestion/t/${encodeURIComponent(tconst)}.json`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ImdbSuggestPayload;
    const hit = data.d?.find((row) => row.id?.toLowerCase() === tconst.toLowerCase());
    const imageUrl = hit?.i?.imageUrl?.trim();
    if (!imageUrl) return null;
    // Prefer a moderate size for storage.
    return imageUrl.replace(/\._V1_.*$/, '._V1_SX500.jpg');
  } catch (err) {
    console.warn(`  ! IMDb suggestion failed for ${tconst}:`, err);
    return null;
  }
}

/**
 * Fetch cover URL (remote), plot text, and optional gallery remote URLs.
 * Does not download files — caller downloads into uploads/.
 */
export async function fetchMovieEnrichment(
  tconst: string,
  opts: {
    needCover: boolean;
    needPlot: boolean;
    needGallery: boolean;
    title?: string;
    year?: number | null;
    wikipediaTitleHint?: string | null;
  },
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    remoteCoverUrl: null,
    plot: null,
    galleryUrls: [],
    source: { cover: null, plot: null },
  };

  let remoteCover: string | null = null;

  const omdb =
    opts.needCover || opts.needPlot ? await fetchOmdb(tconst) : null;
  if (omdb) {
    if (opts.needCover && omdb.Poster && omdb.Poster !== 'N/A') {
      remoteCover = omdb.Poster;
      result.source.cover = 'omdb';
    }
    if (opts.needPlot && omdb.Plot && omdb.Plot !== 'N/A') {
      result.plot = omdb.Plot.trim();
      result.source.plot = 'omdb';
    }
  }

  if (
    (opts.needCover && !remoteCover) ||
    (opts.needGallery && result.galleryUrls.length === 0)
  ) {
    const tmdb = await fetchTmdbByImdb(tconst);
    if (tmdb) {
      if (opts.needCover && !remoteCover && tmdb.posterUrl) {
        remoteCover = tmdb.posterUrl;
        result.source.cover = 'tmdb';
      }
      if (opts.needGallery && tmdb.galleryUrls.length > 0) {
        result.galleryUrls = tmdb.galleryUrls;
      }
    }
  }

  if (opts.needCover && !remoteCover) {
    const suggest = await fetchImdbSuggestionPoster(tconst);
    if (suggest) {
      remoteCover = suggest;
      result.source.cover = 'imdb-suggest';
    }
  }

  // Wikipedia for plots (and cover fallback only when also needing a plot, to
  // avoid slow wiki retries on covers-only passes).
  if (
    (opts.needPlot && !result.plot) ||
    (opts.needCover && !remoteCover && opts.needPlot)
  ) {
    const wiki = await fetchWikipediaForMovie({
      title: opts.title ?? '',
      year: opts.year,
      wikipediaTitleHint: opts.wikipediaTitleHint,
      imdbId: opts.needPlot && !result.plot ? tconst : null,
    });
    if (wiki) {
      if (opts.needPlot && !result.plot && wiki.extract) {
        result.plot = wiki.extract;
        result.source.plot = 'wikipedia';
      }
      if (opts.needCover && !remoteCover && wiki.thumbnailUrl) {
        remoteCover = wiki.thumbnailUrl;
        result.source.cover = 'wikipedia';
      }
    }
  }

  result.remoteCoverUrl = remoteCover;
  return result;
}

export async function downloadCoverFromRemote(
  remoteUrl: string,
  tconst: string,
  uploadDir: string,
): Promise<string | null> {
  const filename = `cover-movie-imdb-${tconst}${extFromUrl(remoteUrl)}`;
  return downloadImage(remoteUrl, filename, uploadDir);
}

export async function downloadGalleryFromRemotes(
  remoteUrls: string[],
  tconst: string,
  uploadDir: string,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < remoteUrls.length; i++) {
    const url = remoteUrls[i]!;
    const filename = `photo-movie-imdb-${tconst}-${i}${extFromUrl(url)}`;
    const publicPath = await downloadImage(url, filename, uploadDir);
    if (publicPath) out.push(publicPath);
  }
  return out;
}

export function describeAvailableSources(): string {
  const hasOmdb = Boolean(process.env.OMDB_API_KEY?.trim());
  const hasTmdb = Boolean(process.env.TMDB_API_KEY?.trim());
  const parts = [
    hasOmdb && 'OMDb',
    hasTmdb && 'TMDB',
    'IMDb-suggest (covers)',
    'Wikipedia (plots + cover fallback)',
  ].filter(Boolean);
  return parts.join(' + ');
}
