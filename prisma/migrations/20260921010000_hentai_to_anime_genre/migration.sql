-- Hentai is a genre of Anime, not its own media type / user shelf.

-- 1. Ensure the Hentai genre exists (slug `hentai`).
INSERT INTO "Genre" (id, name, slug, "createdAt")
SELECT 'clhentai000000000000000001', 'Hentai', 'hentai', CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "Genre"
  WHERE slug = 'hentai' OR lower(name) = 'hentai'
);

-- 2. Attach Hentai genre to every title still typed as HENTAI.
INSERT INTO "MediaGenre" ("mediaId", "genreId")
SELECT m.id, g.id
FROM "Media" m
CROSS JOIN "Genre" g
WHERE m.type = 'HENTAI'
  AND (g.slug = 'hentai' OR lower(g.name) = 'hentai')
ON CONFLICT ("mediaId", "genreId") DO NOTHING;

-- 3. Reclassify those titles as adult Anime (RX when rating is missing or all-ages).
UPDATE "Media"
SET
  type = 'ANIME',
  "isAdult" = true,
  "contentRating" = CASE
    WHEN "contentRating" IS NULL OR "contentRating" IN ('G', 'PG', 'PG_13') THEN 'RX'
    ELSE "contentRating"
  END
WHERE type = 'HENTAI';

-- 4. Users with a Hentai shelf but no Anime shelf: convert one Hentai shelf to Anime.
UPDATE "Category" AS h
SET
  kind = 'ANIME',
  name = 'Anime',
  slug = CASE
    WHEN EXISTS (
      SELECT 1 FROM "Category" c
      WHERE c."userId" = h."userId" AND c.slug = 'anime' AND c.id <> h.id
    ) THEN 'anime-' || left(h.id, 8)
    ELSE 'anime'
  END
WHERE h.id IN (
  SELECT DISTINCT ON ("userId") id
  FROM "Category"
  WHERE kind = 'HENTAI'
    AND "userId" NOT IN (SELECT "userId" FROM "Category" WHERE kind = 'ANIME')
  ORDER BY
    "userId",
    CASE WHEN slug = 'hentai' THEN 0 ELSE 1 END,
    "sortOrder",
    id
);

-- 5. Drop Hentai-shelf items whose media already lives on the user's Anime shelf.
DELETE FROM "Item" i
USING "Category" h
WHERE i."categoryId" = h.id
  AND h.kind = 'HENTAI'
  AND i."mediaId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "Item" a
    JOIN "Category" ac ON a."categoryId" = ac.id
    WHERE ac."userId" = h."userId"
      AND ac.kind = 'ANIME'
      AND a."mediaId" = i."mediaId"
  );

-- 6. Move remaining Hentai-shelf items onto the user's Anime shelf.
UPDATE "Item" i
SET "categoryId" = ac.id
FROM "Category" h
JOIN "Category" ac ON ac."userId" = h."userId" AND ac.kind = 'ANIME'
WHERE i."categoryId" = h.id
  AND h.kind = 'HENTAI';

-- 7. Delete leftover Hentai shelves (items already moved or empty).
DELETE FROM "Category"
WHERE kind = 'HENTAI';

-- 8. Drop unused enum values (Postgres has no ALTER TYPE … DROP VALUE here).
CREATE TYPE "MediaType_new" AS ENUM ('ANIME', 'MOVIE', 'SERIAL', 'BOOK');
ALTER TABLE "Media" ALTER COLUMN "type" TYPE "MediaType_new"
  USING ("type"::text::"MediaType_new");
ALTER TYPE "MediaType" RENAME TO "MediaType_old";
ALTER TYPE "MediaType_new" RENAME TO "MediaType";
DROP TYPE "MediaType_old";

CREATE TYPE "CategoryKind_new" AS ENUM ('ANIME', 'MOVIE', 'SERIAL', 'BOOK');
ALTER TABLE "Category" ALTER COLUMN "kind" TYPE "CategoryKind_new"
  USING ("kind"::text::"CategoryKind_new");
ALTER TYPE "CategoryKind" RENAME TO "CategoryKind_old";
ALTER TYPE "CategoryKind_new" RENAME TO "CategoryKind";
DROP TYPE "CategoryKind_old";
