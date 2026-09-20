-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "year" INTEGER,
    "coverUrl" TEXT,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Media" ("coverUrl", "createdAt", "description", "id", "title", "type", "updatedAt", "year") SELECT "coverUrl", "createdAt", "description", "id", "title", "type", "updatedAt", "year" FROM "Media";
DROP TABLE "Media";
ALTER TABLE "new_Media" RENAME TO "Media";
CREATE INDEX "Media_type_idx" ON "Media"("type");
CREATE INDEX "Media_title_idx" ON "Media"("title");
CREATE INDEX "Media_isAdult_idx" ON "Media"("isAdult");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT,
    "profileBackgroundUrl" TEXT,
    "profileHidden" BOOLEAN NOT NULL DEFAULT false,
    "profileColors" JSONB,
    "websiteUrl" TEXT,
    "sex" TEXT NOT NULL DEFAULT 'PREFER_NOT_TO_SAY',
    "dateOfBirth" DATETIME,
    "displayAge" BOOLEAN NOT NULL DEFAULT false,
    "displayAdultContent" BOOLEAN NOT NULL DEFAULT false,
    "interfaceLanguage" TEXT NOT NULL DEFAULT 'en',
    "googleId" TEXT,
    "googleConnectedAt" DATETIME,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatarUrl", "bio", "createdAt", "displayName", "email", "id", "passwordHash", "profileBackgroundUrl", "profileColors", "profileHidden", "role", "updatedAt", "username") SELECT "avatarUrl", "bio", "createdAt", "displayName", "email", "id", "passwordHash", "profileBackgroundUrl", "profileColors", "profileHidden", "role", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
