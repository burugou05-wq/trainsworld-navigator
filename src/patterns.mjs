export function compareServices(lines, edges, complexOf) {
  const edgeById = new Map(edges.map(edge => [edge.id, edge]));
  const stationOf = id => complexOf.get(id) ?? id;
  const patterns = lines.map(line => {
    const stops = new Map();
    line.stops.forEach((node, index) => {
      const id = stationOf(node);
      if (!stops.has(id)) stops.set(id, []);
      stops.get(id).push(index + 1);
    });
    const via = new Set(line.path.flatMap(directed => {
      const edge = edgeById.get(Math.floor(directed / 2));
      return edge ? [stationOf(edge.from), stationOf(edge.to)] : [];
    }));
    return { stops, via };
  });
  const stations = new Set([...patterns].sort((a, b) => b.stops.size - a.stops.size)
    .flatMap(pattern => [...pattern.stops.keys()]));
  return [...stations].map(id => ({
    id,
    calls: patterns.map(({ stops, via }) => ({
      positions: stops.get(id) ?? [],
      passes: !stops.has(id) && via.has(id),
    })),
  }));
}
