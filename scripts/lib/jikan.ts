/**
 * Jikan (unofficial MyAnimeList API) helpers for cover backfill.
 * Docs: https://docs.api.jikan.moe/
 */

import { sleep } from './shikimori.js';

export const JIKAN_ORIGIN = 'https://api.jikan.moe/v4';
/** Jikan free tier ~3 req/sec soft limit; stay polite. */
export const JIKAN_GAP_MS = 400;

export type JikanAnime = {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese: string | null;
  year: number | null;
  aired?: { from?: string | null } | null;
  images?: {
    jpg?: { image_url?: string; large_image_url?: string };
    webp?: { image_url?: string; large_image_url?: string };
  };
};

let lastRequestAt = 0;

async function throttle(gapMs = JIKAN_GAP_MS) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < gapMs) await sleep(gapMs - elapsed);
  lastRequestAt = Date.now();
}

export async function searchJikanAnime(
  search: string,
  limit = 5,
  attempt = 0,
): Promise<JikanAnime[]> {
  await throttle();
  const params = new URLSearchParams({
    q: search,
    limit: String(Math.min(limit, 25)),
    sfw: 'false',
  });
  const res = await fetch(`${JIKAN_ORIGIN}/anime?${params}`, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(res.status === 429 ? 1500 : 1200 * (attempt + 1));
    return searchJikanAnime(search, limit, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Jikan HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: JikanAnime[] };
  return json.data ?? [];
}

function normTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[★☆]/g, '')
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function yearOf(m: JikanAnime): number | null {
  if (m.year != null) return m.year;
  const from = m.aired?.from;
  if (!from) return null;
  const match = /^(\d{4})/.exec(from);
  return match ? Number(match[1]) : null;
}

export function pickJikanMatch(
  hits: JikanAnime[],
  title: string,
  year: number | null,
): JikanAnime | null {
  if (!hits.length) return null;
  const want = normTitle(title);
  const scored = hits.map((m) => {
    const titles = [m.title, m.title_english, m.title_japanese].map(normTitle);
    let score = 0;
    const y = yearOf(m);
    if (year != null && y === year) score += 10;
    if (titles.includes(want)) score += 5;
    else if (titles.some((t) => t && (t.includes(want) || want.includes(t)))) {
      score += 2;
    } else {
      score += 1; // search already ranked — soft accept
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.m ?? null;
}

export function jikanCoverUrl(media: JikanAnime): string | null {
  return (
    media.images?.jpg?.large_image_url ||
    media.images?.webp?.large_image_url ||
    media.images?.jpg?.image_url ||
    media.images?.webp?.image_url ||
    null
  );
}
