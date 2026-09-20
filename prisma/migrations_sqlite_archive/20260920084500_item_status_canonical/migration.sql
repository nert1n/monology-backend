-- Restore canonical ItemStatus vocabulary and keep PAUSED:
-- WATCHING → IN_PROGRESS
-- WATCHED → DONE
-- CANCELLED → DROPPED
-- PLANNED / PAUSED unchanged

UPDATE "Item" SET "status" = 'IN_PROGRESS' WHERE "status" = 'WATCHING';
UPDATE "Item" SET "status" = 'DONE' WHERE "status" = 'WATCHED';
UPDATE "Item" SET "status" = 'DROPPED' WHERE "status" = 'CANCELLED';
