CREATE TABLE anylist_selected_lists (
  household_id INTEGER NOT NULL REFERENCES anylist_connections(household_id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  list_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  last_success_at TEXT,
  unavailable INTEGER NOT NULL DEFAULT 0 CHECK(unavailable IN (0,1)),
  PRIMARY KEY(household_id,list_id)
);

INSERT INTO anylist_selected_lists(household_id,list_id,list_name,items_json,last_success_at)
SELECT household_id,list_id,COALESCE(list_name,list_id),items_json,last_success_at
FROM anylist_connections WHERE list_id IS NOT NULL;
