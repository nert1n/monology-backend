-- Remap legacy shelves onto Anime / Movies / Books
UPDATE "Category"
SET
  "kind" = 'ANIME',
  "name" = 'Anime',
  "slug" = 'anime',
  "sortOrder" = 0,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" IN ('WATCH')
   OR "slug" IN ('watched', 'anime');

UPDATE "Category"
SET
  "kind" = 'MOVIE',
  "name" = 'Movies',
  "slug" = 'movies',
  "sortOrder" = 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" IN ('PLAY')
   OR "slug" IN ('played', 'games', 'movies');

UPDATE "Category"
SET
  "kind" = 'BOOK',
  "name" = 'Books',
  "slug" = 'books',
  "sortOrder" = 3,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" IN ('READ')
   OR "slug" IN ('read', 'books');

UPDATE "Category"
SET
  "kind" = 'SERIAL',
  "name" = 'Serials',
  "slug" = 'serials',
  "sortOrder" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'serials';

-- Ensure every user has Serials
INSERT INTO "Category" ("id", "userId", "name", "slug", "kind", "sortOrder", "createdAt", "updatedAt")
SELECT
  lower(hex(randomblob(12))),
  "User"."id",
  'Serials',
  'serials',
  'SERIAL',
  2,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User"
WHERE NOT EXISTS (
  SELECT 1 FROM "Category"
  WHERE "Category"."userId" = "User"."id" AND "Category"."slug" = 'serials'
);

-- Drop leftover custom / obsolete shelves (items cascade)
DELETE FROM "Category"
WHERE "kind" NOT IN ('ANIME', 'MOVIE', 'SERIAL', 'BOOK')
   OR "slug" NOT IN ('anime', 'movies', 'serials', 'books');

-- Normalize legacy media types if any
UPDATE "Media" SET "type" = 'BOOK' WHERE "type" IN ('AUDIOBOOK');
UPDATE "Media" SET "type" = 'MOVIE' WHERE "type" IN ('GAME', 'OTHER');
