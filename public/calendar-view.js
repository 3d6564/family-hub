/** Return the visible calendar weeks, rolling forward in the live month's final week. */
export function calendarGridWindow(month, today, weekStartsOn, pinned = false) {
  const year = month.getFullYear(), monthIndex = month.getMonth();
  const first = new Date(year, monthIndex, 1), last = new Date(year, monthIndex + 1, 0);
  const weekdayOffset = (date) => (date.getDay() - weekStartsOn + 7) % 7;
  const finalWeekStart = new Date(last);
  finalWeekStart.setDate(last.getDate() - weekdayOffset(last));
  const isLiveMonth = !pinned && today.getFullYear() === year && today.getMonth() === monthIndex;
  const rollingForward = isLiveMonth && today >= finalWeekStart;
  const gridStart = rollingForward ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : new Date(first);
  gridStart.setDate(gridStart.getDate() - weekdayOffset(gridStart));
  const offset = weekdayOffset(first);
  const cellCount = rollingForward ? 35 : Math.ceil((last.getDate() + offset) / 7) * 7;
  return { gridStart, cellCount, rollingForward };
}
