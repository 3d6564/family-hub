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

function dateKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function dateFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Return each local day an event covers. All-day end dates are exclusive. */
export function eventSpanDays(event) {
  const startKey = event.start?.date || (event.start?.dateTime ? dateKey(new Date(event.start.dateTime)) : null);
  if (!startKey) return [];
  const start = dateFromKey(startKey);
  let endExclusive;
  if (event.end?.date) endExclusive = dateFromKey(event.end.date);
  else if (event.end?.dateTime) {
    const end = new Date(event.end.dateTime);
    endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (end.getHours() || end.getMinutes() || end.getSeconds() || end.getMilliseconds()) endExclusive.setDate(endExclusive.getDate() + 1);
  } else {
    endExclusive = new Date(start);
    endExclusive.setDate(start.getDate() + 1);
  }
  if (!(endExclusive > start)) {
    endExclusive = new Date(start);
    endExclusive.setDate(start.getDate() + 1);
  }
  const days = [];
  for (const cursor = new Date(start); cursor < endExclusive; cursor.setDate(cursor.getDate() + 1)) days.push(dateKey(cursor));
  return days.map((date, index) => ({ date, position: days.length === 1 ? 'single' : index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle' }));
}
