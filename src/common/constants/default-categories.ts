import { CategoryKind } from '../../../generated/prisma/index.js';

export const DEFAULT_CATEGORIES: Array<{
  name: string;
  slug: string;
  kind: CategoryKind;
  sortOrder: number;
}> = [
  { name: 'Anime', slug: 'anime', kind: CategoryKind.ANIME, sortOrder: 0 },
  { name: 'Movies', slug: 'movies', kind: CategoryKind.MOVIE, sortOrder: 1 },
  { name: 'Serials', slug: 'serials', kind: CategoryKind.SERIAL, sortOrder: 2 },
  { name: 'Books', slug: 'books', kind: CategoryKind.BOOK, sortOrder: 3 },
  { name: 'Hentai', slug: 'hentai', kind: CategoryKind.HENTAI, sortOrder: 4 },
];
