function distance(a, b) {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return Infinity;
  const dx = ((b.lon - a.lon + 540) % 360 - 180) * Math.cos((a.lat + b.lat) * Math.PI / 360);
  return Math.hypot(dx, b.lat - a.lat) * 111195;
}

export function matchingStation(base, other, id) {
  const members = base.complexes.get(id)?.members ?? [];
  const candidates = new Set();
  for (const member of members) {
    const original = base.stations.get(member);
    const sameId = other.stations.get(member);
    if (sameId && distance(original, sameId) <= 15 && other.complexOf.has(member)) {
      candidates.add(other.complexOf.get(member));
    }
  }
  if (candidates.size) return candidates.size === 1 ? [...candidates][0] : undefined;
  for (const member of members) {
    const original = base.stations.get(member);
    const name = base.stationNames.get(id);
    for (const station of other.stations.values()) {
      const target = other.complexOf.get(station.id);
      if (target !== undefined && distance(original, station) <= 500 &&
          (station.name === original.name || other.stationNames.get(target) === name)) candidates.add(target);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}
