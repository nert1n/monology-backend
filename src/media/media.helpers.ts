import { ContentRating } from '../../generated/prisma/index.js';

const ADULT_RATINGS = new Set<ContentRating>([
  ContentRating.NC_17,
  ContentRating.R_18,
  ContentRating.RX,
]);

const HENTAI_GENRE_KEYS = new Set(['hentai', 'хентай']);

export function isAdultContentRating(
  rating: ContentRating | null | undefined,
): boolean {
  return rating != null && ADULT_RATINGS.has(rating);
}

export function isHentaiGenreName(name: string): boolean {
  return HENTAI_GENRE_KEYS.has(name.trim().toLowerCase());
}

export function hasHentaiGenre(names: string[] | undefined): boolean {
  return Boolean(names?.some(isHentaiGenreName));
}

/** Hentai genre and 18+/RX/NC-17 always count as adult; otherwise honor explicit flag. */
export function resolveIsAdult(input: {
  contentRating?: ContentRating | null;
  isAdult?: boolean | null;
  genres?: string[] | null;
}): boolean {
  if (isAdultContentRating(input.contentRating)) return true;
  if (hasHentaiGenre(input.genres ?? undefined)) return true;
  return input.isAdult ?? false;
}

export function slugifyGenreName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .normalize('NFKD')
    // Keep latin + digits + letters from other scripts (e.g. Cyrillic).
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function normalizeGenreNames(names: string[] | undefined): string[] {
  if (!names?.length) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name.slice(0, 80));
  }
  return result;
}
