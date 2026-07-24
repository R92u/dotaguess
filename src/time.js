const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export function getMoscowDateKey(date = new Date()) {
  const shifted = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

export function getNextMoscowMidnightIso(date = new Date()) {
  const shifted = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  const nextMidnightShiftedUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
    0,
    0,
    0
  );
  return new Date(nextMidnightShiftedUtc - MOSCOW_OFFSET_MS).toISOString();
}
