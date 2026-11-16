const HOUR = 3600;
const DAY = 24 * HOUR;
const bands = [
  { start: 0, end: 6 * HOUR, period: 2 },
  { start: 6 * HOUR, end: 20 * HOUR, period: 0 },
  { start: 20 * HOUR, end: DAY, period: 1 },
];

function bandAt(time) {
  const day = Math.floor(time / DAY) * DAY;
  return bands.find(band => time < day + band.end);
}

export const demandAt = time => bandAt(time).period;

// An expected wait consumes half a headway. A band with zero service
// consumes clock time but contributes no progress toward the next train.
export function boardingTime(time, rates, direction = 1) {
  if (!rates?.some(rate => rate > 0)) return null;
  return advance(time, rates, 1800, direction);
}

export function travelTime(time, seconds, direction = 1) {
  if (seconds.every(value => value === seconds[0])) return seconds[0];
  return Math.abs(advance(time, seconds.map(value => 1 / Math.max(0.001, value)), 1, direction) - time);
}

function advance(time, rates, work, direction) {
  const daily = (14 * rates[0] + 4 * rates[1] + 6 * rates[2]) * HOUR;
  let remaining = work;
  const wholeDays = Math.max(0, Math.ceil(remaining / daily) - 1);
  remaining -= wholeDays * daily;
  let cursor = time + direction * wholeDays * DAY;
  for (;;) {
    let day = Math.floor(cursor / DAY) * DAY;
    if (direction === -1 && cursor === day) day -= DAY;
    const band = direction === 1 ? bandAt(cursor) : bands.find(item => cursor <= day + item.end);
    const boundary = day + (direction === 1 ? band.end : band.start);
    const rate = rates[band.period];
    const progress = Math.abs(boundary - cursor) * rate;
    if (rate > 0 && progress >= remaining - 1e-8) {
      return cursor + direction * Math.min(progress, remaining) / rate;
    }
    remaining -= progress;
    cursor = boundary;
  }
}

export function clockLabel(time, reference) {
  const rounded = Math.round(time / 60);
  const day = Math.floor(rounded / 1440);
  const minute = rounded - day * 1440;
  const relative = day - Math.floor(reference / DAY);
  const prefix = relative === 1 ? '翌日 ' : relative === -1 ? '前日 ' :
    relative > 1 ? relative + '日後 ' : relative < -1 ? -relative + '日前 ' : '';
  return prefix + String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}
