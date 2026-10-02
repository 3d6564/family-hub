ALTER TABLE chores ADD COLUMN reward_quarters INTEGER NOT NULL DEFAULT 0 CHECK(reward_quarters >= 0);
