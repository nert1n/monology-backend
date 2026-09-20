-- AlterTable
ALTER TABLE "Media" ADD COLUMN "status" TEXT;
ALTER TABLE "Media" ADD COLUMN "episodeCount" INTEGER;
ALTER TABLE "Media" ADD COLUMN "episodesAired" INTEGER;
ALTER TABLE "Media" ADD COLUMN "contentRating" TEXT;

-- CreateIndex
CREATE INDEX "Media_status_idx" ON "Media"("status");
CREATE INDEX "Media_contentRating_idx" ON "Media"("contentRating");

-- CreateTable
CREATE TABLE "Genre" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Genre_name_key" ON "Genre"("name");
CREATE UNIQUE INDEX "Genre_slug_key" ON "Genre"("slug");
CREATE INDEX "Genre_name_idx" ON "Genre"("name");

-- CreateTable
CREATE TABLE "MediaGenre" (
    "mediaId" TEXT NOT NULL,
    "genreId" TEXT NOT NULL,

    PRIMARY KEY ("mediaId", "genreId"),
    CONSTRAINT "MediaGenre_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaGenre_genreId_fkey" FOREIGN KEY ("genreId") REFERENCES "Genre" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MediaGenre_genreId_idx" ON "MediaGenre"("genreId");

-- Seed Hentai shelf for every existing user (auto-seeded shelves)
INSERT INTO "Category" ("id", "userId", "name", "slug", "kind", "sortOrder", "createdAt", "updatedAt")
SELECT
  lower(hex(randomblob(12))),
  "User"."id",
  'Hentai',
  'hentai',
  'HENTAI',
  4,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User"
WHERE NOT EXISTS (
  SELECT 1 FROM "Category"
  WHERE "Category"."userId" = "User"."id" AND "Category"."slug" = 'hentai'
);
