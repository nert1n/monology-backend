/**
 * Shared Shikimori API helpers for import scripts.
 * API docs: https://shikimori.io/api/doc/1.0
 * Live host used by existing imports: https://shikimori.io
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContentRating,
  MediaStatus,
} from '../../generated/prisma/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(__dirname, '../..');

export const SHIKI_ORIGIN = 'https://shikimori.io';
export const USER_AGENT =
  'monology-list-import/1.0 (local seed; contact: dymufa@gmail.com)';
export const MEDIA_PUBLIC_PREFIX = '/uploads/media';
export const CACHE_DIR = path.join(
  BACKEND_ROOT,
  'scripts',
  '.cache',
  'shikimori-anime',
);
export const UPLOAD_DIR = path.join(BACKEND_ROOT, 'uploads', 'media');
export const REQUEST_GAP_MS = 350;
export const LIST_PAGE_LIMIT = 50;

export type ShikiScreenshot = { original: string; preview?: string };

export type ShikiGenre = {
  id: number;
  name: string;
  russian?: string | null;
  kind?: string | null;
  entry_type?: string | null;
};

export type ShikiAnimeListItem = {
  id: number;
  name: string;
  russian?: string | null;
  image?: { original?: string; preview?: string } | null;
  url?: string;
  kind?: string | null;
  score?: string | null;
  status?: string | null;
  episodes?: number;
  episodes_aired?: number;
  aired_on?: string | null;
  released_on?: string | null;
  rating?: string | null;
};

export type ShikiAnime = ShikiAnimeListItem & {
  description?: string | null;
  english?: string[] | null;
  japanese?: string[] | null;
  synonyms?: string[] | null;
  screenshots?: ShikiScreenshot[] | null;
  genres?: ShikiGenre[] | null;
};

let lastRequestAt = 0;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function throttle(gapMs = REQUEST_GAP_MS) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < gapMs) {
    await sleep(gapMs - elapsed);
  }
  lastRequestAt = Date.now();
}

export function yearFromAiredOn(airedOn: string | null | undefined): number | null {
  if (!airedOn) return null;
  const match = /^(\d{4})/.exec(airedOn);
  return match ? Number(match[1]) : null;
}

/** Map Shikimori anime status → MediaStatus. */
export function mapShikiStatus(
  status: string | null | undefined,
): MediaStatus | null {
  switch ((status ?? '').toLowerCase()) {
    case 'anons':
      return MediaStatus.ANNOUNCED;
    case 'ongoing':
      return MediaStatus.ONGOING;
    case 'released':
      return MediaStatus.ENDED;
    default:
      return null;
  }
}

/**
 * Map Shikimori age rating → ContentRating.
 * r_plus (mild nudity) → NC_17; rx (hentai) → RX.
 */
export function mapShikiContentRating(
  rating: string | null | undefined,
): ContentRating | null {
  switch ((rating ?? '').toLowerCase()) {
    case 'g':
      return ContentRating.G;
    case 'pg':
      return ContentRating.PG;
    case 'pg_13':
      return ContentRating.PG_13;
    case 'r':
      return ContentRating.R;
    case 'r_plus':
      return ContentRating.NC_17;
    case 'r_18':
    case 'r18':
      return ContentRating.R_18;
    case 'rx':
      return ContentRating.RX;
    default:
      return null;
  }
}

export function isAdultShikiRating(
  rating: string | null | undefined,
): boolean {
  const mapped = mapShikiContentRating(rating);
  return (
    mapped === ContentRating.NC_17 ||
    mapped === ContentRating.R_18 ||
    mapped === ContentRating.RX
  );
}

/** Prefer English genre names; skip theme/demographic noise if kind is set. */
export function genreNamesFromShiki(
  genres: ShikiGenre[] | null | undefined,
): string[] {
  if (!genres?.length) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const g of genres) {
    if (g.kind && g.kind !== 'genre') continue;
    const name = (g.name ?? g.russian ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name.slice(0, 80));
  }
  return names;
}

export function stripBbCode(text: string): string {
  return text
    .replace(/\[character=\d+\]([^\]]+)\[\/character\]/gi, '$1')
    .replace(/\[anime=\d+\]([^\]]+)\[\/anime\]/gi, '$1')
    .replace(/\[\[.*?\|(.*?)\]\]/g, '$1')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

export function absoluteShikiUrl(relativeOrAbsolute: string): string {
  if (relativeOrAbsolute.startsWith('http')) return relativeOrAbsolute;
  return `${SHIKI_ORIGIN}${relativeOrAbsolute.startsWith('/') ? '' : '/'}${relativeOrAbsolute}`;
}

export function isMissingShikiImage(pathOrUrl: string | null | undefined): boolean {
  if (!pathOrUrl) return true;
  return pathOrUrl.includes('/assets/globals/missing_');
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

export function uniqueFilename(prefix: string, url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
  const rand = randomBytes(3).toString('hex');
  return `${prefix}-${hash}-${rand}${extFromUrl(url)}`;
}

export async function fetchJson<T>(url: string): Promise<T> {
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

export async function listAnimesPage(options: {
  page: number;
  limit?: number;
  order?: string;
  censored?: boolean;
  /** SeasonString: `2026`, `winter_2026`, `2014_2016`, … */
  season?: string;
}): Promise<ShikiAnimeListItem[]> {
  const limit = options.limit ?? LIST_PAGE_LIMIT;
  const order = options.order ?? 'id';
  const params = new URLSearchParams({
    page: String(options.page),
    limit: String(limit),
    order,
  });
  if (options.season) {
    params.set('season', options.season);
  }
  if (options.censored === false) {
    params.set('censored', 'false');
  }
  return fetchJson<ShikiAnimeListItem[]>(
    `${SHIKI_ORIGIN}/api/animes?${params.toString()}`,
  );
}

/** Title search — useful when Media has no stored Shikimori id. */
export async function searchAnimes(options: {
  search: string;
  limit?: number;
  censored?: boolean;
}): Promise<ShikiAnimeListItem[]> {
  const limit = Math.min(options.limit ?? 10, 50);
  const params = new URLSearchParams({
    search: options.search,
    limit: String(limit),
    order: 'ranked',
  });
  if (options.censored === false) {
    params.set('censored', 'false');
  }
  return fetchJson<ShikiAnimeListItem[]>(
    `${SHIKI_ORIGIN}/api/animes?${params.toString()}`,
  );
}

/** Best poster path from a list/detail payload, or null if missing placeholder. */
export function shikiCoverRel(
  image: ShikiAnimeListItem['image'] | null | undefined,
): string | null {
  const original = image?.original ?? null;
  if (original && !isMissingShikiImage(original)) return original;
  const preview = image?.preview ?? null;
  if (preview && !isMissingShikiImage(preview)) return preview;
  return null;
}

export async function loadShikiAnime(id: number): Promise<ShikiAnime | null> {
  const cachePath = path.join(CACHE_DIR, `${id}.json`);
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
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(data), 'utf8');
    return data;
  } catch (err) {
    console.warn(`  ! shikimori fetch failed for ${id}:`, err);
    return null;
  }
}

export async function downloadImage(
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
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, filename), buf);
    return `${MEDIA_PUBLIC_PREFIX}/${filename}`;
  } catch (err) {
    console.warn(`  ! image download failed: ${url}`, err);
    return null;
  }
}
