ALTER TABLE chores ADD COLUMN days TEXT;
UPDATE chores SET days = CASE recurrence
  WHEN 'daily' THEN '0,1,2,3,4,5,6'
  WHEN 'weekly' THEN CAST(strftime('%w', due_on) AS TEXT)
  ELSE NULL
END;
