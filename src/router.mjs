import { runSeconds } from './save.mjs';
import { boardingTime, demandAt, travelTime } from './serviceclock.mjs';

class Heap {
  items = [];
  constructor(compare) { this.compare = compare; }
  push(value) {
    const a = this.items;
    let i = a.length;
    a.push(value);
    while (i && this.compare(value, a[(i - 1) >> 1]) < 0) {
      a[i] = a[(i - 1) >> 1];
      i = (i - 1) >> 1;
    }
    a[i] = value;
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (!a.length) return first;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let child = i * 2 + 1;
      if (child + 1 < a.length && this.compare(a[child + 1], a[child]) < 0) child++;
      if (this.compare(last, a[child]) <= 0) break;
      a[i] = a[child];
      i = child;
    }
    a[i] = last;
    return first;
  }
}

export const PERIODS = ['高需要', '中需要', '低需要'];

export function fareModel(network) {
  const f = network.fares;
  if (!f || f.ref !== 'JP' || f.hsr || f.transfer || f.income !== 0.5 ||
    Object.keys(f.scales ?? {}).some(key => key !== '@') ||
    !(f.scales?.['@'] > 0) || f.nodes[0][0] !== 0 ||
    network.lines.some(l => (l.fast || l.mode === 'ferry') && l.connected)) return null;
  return { nodes: f.nodes, scale: f.scales['@'] };
}

export function fareAt(model, km) {
  if (!model) return null;
  const { nodes, scale } = model;
  const next = nodes.findIndex(([distance]) => distance >= km);
  const i = next > 0 ? next : next === 0 ? 1 : nodes.length - 1;
  const [a, x] = nodes[i - 1], [b, y] = nodes[i];
  return scale * (x + (y - x) * (km - a) / (b - a));
}

export function buildGraph(network) {
  const stations = new Map(network.stations.map(s => [s.id, s]));
  const complexes = new Map(network.complexes.map(c => [c.id, c]));
  const complexOf = new Map(network.complexes.flatMap(c => c.members.map(id => [id, c.id])));
  const linesByComplex = new Map(network.complexes.map(c => [c.id, new Set()]));
  const boarding = new Map(network.complexes.map(c => [c.id, []]));
  const servicesPerStation = new Map();
  for (const line of network.lines) {
    for (const id of new Set(line.stops)) servicesPerStation.set(id, (servicesPerStation.get(id) ?? 0) + 1);
  }
  const stationNames = new Map();
  for (const { id, members } of network.complexes) {
    const platforms = members.map(member => stations.get(member));
    // The game gives automatically named rail platforms the name of the
    // lowest-ID automatically named rail platform in the same complex.
    const automatic = platforms.filter(s => !s.named && !s.port).sort((a, b) => a.id - b.id)[0];
    const representative = [...platforms].sort((a, b) =>
      Number(Boolean(b.named)) - Number(Boolean(a.named)) ||
      (servicesPerStation.get(b.id) ?? 0) - (servicesPerStation.get(a.id) ?? 0) || a.id - b.id)[0];
    stationNames.set(id, !representative.named && !representative.port && automatic ?
      automatic.name : representative.name);
  }
  const states = [];
  for (const line of network.lines) {
    if (!line.built || !line.connected) continue;
    for (const id of line.stops) linesByComplex.get(complexOf.get(id))?.add(line.id);
    for (const reverse of line.oneWay ? [false] : [false, true]) {
      const stops = reverse ? [...line.stops].reverse() : [...line.stops];
      const timing = line.timing?.[Number(reverse)];
      const distances = timing?.km ?? (reverse ? [...line.hopKm].reverse() : line.hopKm);
      const times = timing?.ride ?? (reverse && line.hopSeconds ?
        line.reverseHopSeconds ?? [...line.hopSeconds].reverse() : line.hopSeconds);
      if (line.loop) stops.pop();
      const first = states.length;
      stops.forEach((station, i) => {
        const id = states.length;
        const next = i + 1 < stops.length ? id + 1 : line.loop ? first : -1;
        const prev = i > 0 ? id - 1 : line.loop ? first + stops.length - 1 : -1;
        const state = { id, line, station, complex: complexOf.get(station), next, prev, distance: distances[i],
          rideSeconds: times?.[i], profile: timing && next !== -1 ? {
            ride: timing.periods.map(p => p.ride[i]),
            dwell: timing.periods.map(p => p.dwell[i]),
          } : null };
        states.push(state);
        if (next !== -1) boarding.get(state.complex)?.push(state);
      });
    }
  }
  return { stations, complexes, complexOf, stationNames, linesByComplex, boarding, states, fare: fareModel(network) };
}

function compareBy(mode) {
  if (mode === 'transfers') return (a, b) => a.changes - b.changes || a.seconds - b.seconds;
  if (mode === 'fare') return (a, b) => a.km - b.km || a.seconds - b.seconds || a.changes - b.changes;
  return (a, b) => a.seconds - b.seconds || a.changes - b.changes;
}

function shortest(graph, from, to, mode, period, excluded, clock) {
  if (clock?.arriveBy) return reverseSearch(graph, from, to, mode, excluded, clock.time);
  const compare = compareBy(mode);
  const heap = new Heap(compare), best = new Map();
  function offer(state, previous, step, seconds, km, changes, key = state.id) {
    const label = { state, previous, step, seconds, km, changes, key };
    if (best.has(key) && compare(label, best.get(key)) >= 0) return;
    best.set(key, label);
    heap.push(label);
  }
  function board(state, previous) {
    if (excluded.has(state.line.id)) return;
    const platformChanged = previous && previous.state.station !== state.station;
    const walk = previous ? (platformChanged ? 180 : 120) : 0;
    const rate = state.line.tph?.[period];
    const ready = (clock?.time ?? 0) + (previous?.seconds ?? 0) + walk;
    const departure = clock ? boardingTime(ready, state.line.tph) : rate > 0 ? ready + 1800 / rate : null;
    if (departure === null) return;
    const wait = departure - ready;
    offer(state, previous, { type: 'board', wait, walk, state },
      (previous?.seconds ?? 0) + walk + wait, previous?.km ?? 0, previous ? previous.changes + 1 : 0,
      'board:' + state.id);
  }

  for (const state of graph.boarding.get(from) ?? []) board(state, null);
  while (heap.items.length) {
    const label = heap.pop(), state = label.state;
    if (label !== best.get(label.key)) continue;
    const justBoarded = label.step.type === 'board';
    if (!justBoarded && state.complex === to) return label;
    if (!justBoarded) {
      for (const candidate of graph.boarding.get(state.complex)) {
        if (candidate.line.id !== state.line.id) board(candidate, label);
      }
    }
    if (state.next < 0) continue;
    const next = graph.states[state.next];
    const now = clock ? clock.time + label.seconds : null;
    const dwell = justBoarded ? 0 : stopDuration(state, now, period);
    const duration = dwell + rideTime(state, now === null ? null : now + dwell, period);
    offer(next, label, { type: 'ride', to: next.station, duration, afterArrival: 0 },
      label.seconds + duration, label.km + Math.round(state.distance * 1000), label.changes);
  }
  return null;
}

function rideTime(state, time, period = 0, direction = 1) {
  if (state.profile) return time === null ? state.profile.ride[period] : travelTime(time, state.profile.ride, direction);
  return Math.max(1, state.rideSeconds ?? runSeconds(state.distance, state.line.fast, state.line.speedLimit));
}

function stopDuration(state, time, period = 0, direction = 1) {
  if (state.profile) return time === null ? state.profile.dwell[period] : travelTime(time, state.profile.dwell, direction);
  return state.line.dwell;
}

function reverseSearch(graph, from, to, mode, excluded, time) {
  const compare = compareBy(mode);
  const heap = new Heap(compare), best = new Map();
  const arrivals = new Map();
  for (const state of graph.states) {
    if (state.prev < 0 || excluded.has(state.line.id)) continue;
    if (!arrivals.has(state.complex)) arrivals.set(state.complex, []);
    arrivals.get(state.complex).push(state);
  }
  function offer(state, previous, step, seconds, km, changes, key) {
    const label = { state, previous, step, seconds, km, changes, key };
    if (best.has(key) && compare(label, best.get(key)) >= 0) return;
    best.set(key, label);
    heap.push(label);
  }
  for (const state of arrivals.get(to) ?? []) {
    offer(state, null, { type: 'end', state, walk: 0 }, 0, 0, 0, 'end:' + state.id);
  }
  while (heap.items.length) {
    const label = heap.pop(), state = label.state;
    if (label !== best.get(label.key)) continue;
    if (label.step.type === 'start') return label;
    const justAlighted = label.step.type === 'end';
    if (!justAlighted) {
      const departure = time - label.seconds;
      const ready = boardingTime(departure, state.line.tph, -1);
      if (ready !== null) {
        const wait = departure - ready;
        if (state.complex === from) {
          offer(state, label, { type: 'start', wait }, time - ready, label.km, label.changes, 'start');
        }
        for (const arriving of arrivals.get(state.complex) ?? []) {
          if (arriving.line.id === state.line.id) continue;
          const walk = arriving.station === state.station ? 120 : 180;
          offer(arriving, label, { type: 'end', state: arriving, boarding: state, walk, wait },
            time - ready + walk, label.km, label.changes + 1, 'end:' + arriving.id);
        }
      }
    }
    if (state.prev < 0) continue;
    const prev = graph.states[state.prev];
    const now = time - label.seconds;
    const afterArrival = justAlighted ? 0 : stopDuration(state, now, 0, -1);
    const duration = rideTime(prev, now - afterArrival, 0, -1) + afterArrival;
    offer(prev, label, { type: 'ride', to: state.station, duration, afterArrival },
      label.seconds + duration, label.km + Math.round(prev.distance * 1000), label.changes, prev.id);
  }
  return null;
}

function itinerary(label, model, clock) {
  const steps = [];
  for (let cursor = label; cursor; cursor = cursor.previous) steps.push(cursor.step);
  const legs = [];
  if (clock?.arriveBy) {
    let wait = steps[0].wait, walk = 0, leg;
    for (let i = 1; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === 'ride') {
        if (!leg) {
          const state = i === 1 ? label.state : steps[i - 1].boarding;
          leg = { line: state.line, stops: [state.station], wait, walk, seconds: 0, hops: [] };
          legs.push(leg);
        }
        leg.stops.push(step.to);
        leg.seconds += step.duration;
        leg.hops.push(step);
      } else {
        wait = step.wait;
        walk = step.walk;
        leg = undefined;
      }
    }
  } else for (const step of steps.reverse()) {
    if (step.type === 'board') {
      legs.push({ line: step.state.line, stops: [step.state.station], wait: step.wait, walk: step.walk, seconds: 0, hops: [] });
    } else {
      const leg = legs.at(-1);
      leg.stops.push(step.to);
      leg.seconds += step.duration;
      leg.hops.push(step);
    }
  }
  const departure = clock ? clock.time - (clock.arriveBy ? label.seconds : 0) : null;
  let arrival = departure;
  if (clock) {
    let time = departure;
    for (const leg of legs) {
      time += leg.walk;
      leg.ready = time;
      leg.departure = boardingTime(time, leg.line.tph);
      leg.wait = leg.departure - time;
      time = leg.departure;
      leg.period = demandAt(time);
      leg.stopArrivals = leg.hops.map(({ duration, afterArrival }) => {
        time += duration;
        return time - afterArrival;
      });
      leg.arrival = time;
    }
    arrival = time;
  }
  return {
    departure, arrival,
    legs, changes: label.changes, seconds: clock ? arrival - departure : label.seconds,
    km: label.km / 1000, fare: fareAt(model, label.km / 1000),
    key: legs.map(leg => [leg.line.id, leg.stops[0], leg.stops.at(-1)].join('/')).join('|'),
  };
}

export function searchRoutes(graph, from, to, { mode = 'fast', period = 0, limit = 3, time, arriveBy = false } = {}) {
  const clock = Number.isFinite(time) ? { time, arriveBy } : null;
  if (from === to || !graph.complexes.has(from) || !graph.complexes.has(to) || (!clock && !PERIODS[period])) return [];
  if (mode === 'fare' && !graph.fare) return [];
  const compare = compareBy(mode);
  const routes = new Map();
  function find(rank, excluded = new Set()) {
    const result = shortest(graph, from, to, rank, period, excluded, clock);
    if (!result) return null;
    const route = itinerary(result, graph.fare, clock);
    routes.set(route.key, route);
    return route;
  }
  const first = find(mode);
  if (!first || limit <= 1) return first ? [first] : [];
  find(mode === 'fast' ? 'transfers' : 'fast');
  if (graph.fare) find('fare');
  for (const leg of first.legs.slice(0, 8)) find(mode, new Set([leg.line.id]));
  const timeRank = clock?.arriveBy ? (a, b) => b.departure - a.departure : (a, b) => a.seconds - b.seconds;
  const rank = mode === 'fare' ? (a, b) => a.fare - b.fare || timeRank(a, b) :
    mode === 'transfers' ? (a, b) => a.changes - b.changes || timeRank(a, b) :
      (a, b) => timeRank(a, b) || a.changes - b.changes;
  return [...routes.values()].sort(rank).filter((r, i) =>
    i === 0 || (r.seconds <= Math.max(first.seconds * 2, first.seconds + 1800) && r.changes <= first.changes + 3),
  ).slice(0, limit);
}
