const PERIOD_ORDER = ['morning', 'after_school', 'bedtime'];

/** Return routine groups for the display. A past period drops completed items and stays open when unfinished items remain. */
export function routinePeriodGroups(routines, currentPeriod, earlierPeriods = []) {
  const current = PERIOD_ORDER.includes(currentPeriod) ? currentPeriod : 'morning';
  const earlier = new Set(earlierPeriods.filter((period) => PERIOD_ORDER.includes(period) && period !== current));
  const start = PERIOD_ORDER.indexOf(current);
  const wrapped = [...PERIOD_ORDER.slice(start), ...PERIOD_ORDER.slice(0, start)];
  const groups = wrapped.flatMap((period) => {
    const past = earlier.has(period);
    const items = routines.filter((routine) => (routine.period || 'morning') === period && (!past || !routine.completed));
    if (past && !items.length) return [];
    return [{ period, items, open: period === current || past }];
  });
  return [...groups.filter((group) => earlier.has(group.period)), ...groups.filter((group) => !earlier.has(group.period))];
}
