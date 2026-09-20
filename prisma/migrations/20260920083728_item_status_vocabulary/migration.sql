-- Remap item statuses to the new vocabulary:
-- PLANNED stays PLANNED
-- IN_PROGRESS → WATCHING
-- DONE → WATCHED
-- DROPPED → CANCELLED
-- PAUSED is new (no existing rows)

UPDATE "Item" SET "status" = 'WATCHING' WHERE "status" = 'IN_PROGRESS';
UPDATE "Item" SET "status" = 'WATCHED' WHERE "status" = 'DONE';
UPDATE "Item" SET "status" = 'CANCELLED' WHERE "status" = 'DROPPED';
