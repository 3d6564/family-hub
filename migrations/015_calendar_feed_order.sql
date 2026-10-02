ALTER TABLE calendar_feeds ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE calendar_feeds AS feed
SET sort_order = (
  SELECT COUNT(*) FROM calendar_feeds AS earlier
  WHERE earlier.household_id = feed.household_id
    AND (earlier.name < feed.name OR (earlier.name = feed.name AND earlier.id < feed.id))
);
