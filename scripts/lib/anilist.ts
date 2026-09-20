/**
 * Minimal AniList GraphQL helpers for cover backfill.
 * Docs: https://docs.anilist.co
 */

import { sleep } from './shikimori.js';

export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
/** Stay under AniList's ~90 req/min soft limit. */
export const ANILIST_GAP_MS = 700;

export type AniListMedia = {
  id: number;
  title: {
    romaji: string | null;
    english: string | null;
    native: string | null;
  };
  startDate: { year: number | null } | null;
  coverImage: {
    large: string | null;
    extraLarge: string | null;
    medium: string | null;
  } | null;
  bannerImage: string | null;
};

let lastRequestAt = 0;

async function throttle(gapMs = ANILIST_GAP_MS) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < gapMs) await sleep(gapMs - elapsed);
  lastRequestAt = Date.now();
}

const SEARCH_QUERY = `query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      startDate { year }
      coverImage { large extraLarge medium }
      bannerImage
    }
  }
}`;

export async function searchAniListAnime(
  search: string,
  perPage = 5,
): Promise<AniListMedia[]> {
  await throttle();
  const res = await fetch(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { search, perPage },
    }),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '5');
    await sleep(Math.max(2000, retryAfter * 1000));
    return searchAniListAnime(search, perPage);
  }
  if (!res.ok) {
    throw new Error(`AniList HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { Page?: { media?: AniListMedia[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    // "Not Found" for empty search — treat as no hits.
    return [];
  }
  return json.data?.Page?.media ?? [];
}

function normTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[★☆]/g, '')
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
    .trim();
}

/** Pick best AniList hit: prefer year match, then exact-ish title. */
export function pickAniListMatch(
  hits: AniListMedia[],
  title: string,
  year: number | null,
): AniListMedia | null {
  if (!hits.length) return null;
  const want = normTitle(title);
  const scored = hits.map((m) => {
    const titles = [
      m.title.romaji,
      m.title.english,
      m.title.native,
    ].map(normTitle);
    let score = 0;
    if (year != null && m.startDate?.year === year) score += 10;
    if (year != null && m.startDate?.year == null) score += 1;
    if (titles.includes(want)) score += 5;
    else if (titles.some((t) => t && (t.includes(want) || want.includes(t)))) {
      score += 2;
    } else if (
      titles.some((t) => {
        if (!t || !want) return false;
        const a = t.split(/\s+/);
        const b = want.split(/\s+/);
        const overlap = a.filter((w) => w.length > 2 && b.includes(w)).length;
        return overlap >= 2;
      })
    ) {
      score += 1;
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Accept year-only or title overlap; fall back to top search hit when sole result.
  if (!best) return null;
  if (best.score >= 1) return best.m;
  if (hits.length === 1) return hits[0];
  return null;
}

export function aniListCoverUrl(media: AniListMedia): string | null {
  return (
    media.coverImage?.extraLarge ||
    media.coverImage?.large ||
    media.coverImage?.medium ||
    null
  );
}
