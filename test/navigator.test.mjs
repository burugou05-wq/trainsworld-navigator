import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { importSave, runSeconds } from '../src/save.mjs';
import { compareServices } from '../src/patterns.mjs';
import { matchingStation } from '../src/savecompare.mjs';
import { boardingTime, clockLabel } from '../src/serviceclock.mjs';
import { buildGraph, fareAt, searchRoutes } from '../src/router.mjs';

const station = id => ({ id, name: id <= 2 ? '同名' : '駅' + id });
const line = (id, stops, hopKm, settings = {}) => ({
  id, name: '系統' + id, stops, hopKm, built: true, connected: true,
  tph: [12, 6, 0], dwell: 30, ...settings,
});
const makeNetwork = (lines, groups = [], fares = null) => {
  const ids = [...new Set(lines.flatMap(l => l.stops))];
  return {
    lines, fares, stations: ids.map(station),
    complexes: [...groups, ...ids.filter(id => !groups.some(g => g.includes(id))).map(id => [id])]
      .map(members => ({ id: members[0], members })),
  };
};
const fixture = process.env.NAVIGATOR_TEST_SAVE;
const day204 = process.env.NAVIGATOR_TEST_SAVE_204;

test('save comparison follows a renamed station and leaves split stations for manual selection', () => {
  const makeGraph = (stations, groups) => buildGraph({
    stations, lines: [], complexes: groups.map(members => ({ id: members[0], members })),
  });
  const original = [{ id: 0, name: '旧駅名', lat: 35, lon: 139 },
    { id: 1, name: '旧駅名', lat: 35, lon: 139.0001 }];
  const base = makeGraph(original, [[0, 1]]);
  const renamed = original.map(station => ({ ...station, name: '新駅名' }));
  assert.equal(matchingStation(base, makeGraph(renamed, [[0, 1]]), 0), 0);
  assert.equal(matchingStation(base, makeGraph(renamed, [[0], [1]]), 0), undefined);
  const unrelated = original.map(station => ({ ...station, lat: 40 }));
  assert.equal(matchingStation(base, makeGraph(unrelated, [[0, 1]]), 0), undefined);
});

const day277 = process.env.NAVIGATOR_TEST_SAVE_277;
const day305 = process.env.NAVIGATOR_TEST_TIMING_305;
test('day-305 Shinkansen matches the game in both directions and for arrive-by', { skip: !day305 }, async () => {
  const bytes = await readFile(day305);
  const detailed = await importSave(new Blob([bytes]));
  const raw = await importSave(new Blob([bytes.subarray(8, 8 + bytes.readUInt32LE(4))]));
  assert.equal(detailed.lines.filter(line => line.timing).length, 65);
  const line = detailed.lines.find(line => line.name === '東海道新幹線');
  const graph = buildGraph(detailed), fallback = buildGraph(raw);
  const [tokyo, nagoya] = [line.stops[0], line.stops.at(-1)].map(id => graph.complexOf.get(id));
  for (const [from, to, expected] of [[nagoya, tokyo, 5410.493355], [tokyo, nagoya, 5407.352552]]) {
    const [r] = searchRoutes(graph, from, to, { time: 8 * 3600 });
    assert.equal(r.legs[0].line.id, line.id);
    assert.ok(Math.abs(r.legs[0].seconds - expected) < 0.001);
    const [plain] = searchRoutes(fallback, from, to, { time: 8 * 3600 });
    assert.ok(Math.abs(plain.legs[0].seconds - expected) < 2);
    const [back] = searchRoutes(graph, from, to, { time: r.arrival, arriveBy: true });
    assert.ok(Math.abs(back.departure - r.departure) < 0.001);
  }
  const [north] = searchRoutes(graph, nagoya, tokyo, { time: 8 * 3600 });
  assert.ok(Math.abs(north.legs[0].stopArrivals[0] - north.legs[0].departure - 4733.690840) < 0.001);
});
test('day-277 export preserves high-speed tracks and routes on the Shinkansen', { skip: !day277 }, async () => {
  const network = await importSave(new Blob([await readFile(day277)]));
  assert.equal(network.stations.length, 505);
  assert.equal(network.lines.length, 63);
  assert.equal(network.edges.filter(edge => edge.highSpeed).length, 10);
  assert.ok(network.lines.every(line => line.connected));
  const line = network.lines.find(line => line.name === '東海道新幹線');
  assert.equal(line.fast, true);
  assert.deepEqual(line.stops, [1285, 1295, 1294]);
  assert.ok(line.hopSeconds.every((seconds, i) => seconds < runSeconds(line.hopKm[i])));
  const graph = buildGraph(network);
  const [route] = searchRoutes(graph, graph.complexOf.get(1285), graph.complexOf.get(1294), { time: 8 * 3600 });
  assert.deepEqual(route.legs.map(leg => leg.line.id), [line.id]);
});

test('estimated boarding integrates service across 20:00 and waits through an overnight closure', () => {
  assert.equal(boardingTime(19 * 3600 + 59 * 60, [12, 6, 0]), 20 * 3600 + 180);
  assert.equal(boardingTime(2 * 3600, [12, 0, 0]), 6 * 3600 + 150);
  assert.equal(boardingTime(6 * 3600 + 150, [12, 0, 0], -1), 6 * 3600);
  assert.equal(boardingTime(0, [0, 0, 0]), null);
  assert.equal(clockLabel(86400 + 6 * 3600, 0), '翌日 06:00');
  assert.equal(clockLabel(-60, 0), '前日 23:59');
});

test('timed transfers switch demand while riding and wait until service resumes', () => {
  const graph = buildGraph(makeNetwork([
    line(0, [0, 1, 2], [1, 1], { hopSeconds: [180, 180], tph: [60, 1, 0] }),
    line(1, [2, 3], [1], { hopSeconds: [180], tph: [12, 0, 0] }),
  ]));
  const [route] = searchRoutes(graph, 0, 3, { time: 19 * 3600 + 58 * 60 });
  assert.equal(route.legs[0].period, 0);
  assert.deepEqual(route.legs[0].stopArrivals, [72090, 72300]);
  assert.equal(route.legs[1].ready, 72420);
  assert.equal(route.legs[1].departure, 86400 + 21600 + 150);
});

test('arrive-by reconstructs transfer and intermediate times and meets the deadline', () => {
  const graph = buildGraph(makeNetwork([
    line(0, [0, 1, 2], [1, 1], { hopSeconds: [180, 180], tph: [60, 1, 0] }),
    line(1, [2, 3], [1], { hopSeconds: [180], tph: [12, 0, 0] }),
  ]));
  const deadline = 86400 + 6 * 3600 + 5 * 60 + 31;
  const [route] = searchRoutes(graph, 0, 3, { time: deadline, arriveBy: true });
  assert.ok(route.arrival <= deadline);
  assert.ok(deadline - route.arrival <= 1);
  assert.equal(route.legs[0].stopArrivals[0], route.legs[0].departure + 180);
  assert.equal(route.legs[1].ready, route.legs[0].arrival + 120);
  const [forward] = searchRoutes(graph, 0, 3, { time: route.departure });
  assert.equal(forward.arrival, route.arrival);
  const [earlier] = searchRoutes(graph, 0, 3, { time: 2 * 3600, arriveBy: true });
  assert.ok(earlier.arrival < 0);
});

test('reads the network before an ERA1 or ERA2 trailer and validates its length', async () => {
  const header = Buffer.from('{"game":"anitabuilder","format":1}');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  const track = Buffer.concat([Buffer.from('TWT6'), Buffer.alloc(20)]);
  const base = Buffer.concat([Buffer.from('TWG1'), size, header, track]);
  const expected = await importSave(new Blob([base]));
  for (const tag of ['ERA1', 'ERA2']) {
    const payload = Buffer.from([0, 0, 0, 0, 5]);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length);
    assert.deepEqual(await importSave(new Blob([gzipSync(Buffer.concat([base, payload, length, Buffer.from(tag)]))])), expected);
    length.writeUInt32LE(base.length);
    await assert.rejects(importSave(new Blob([base, payload, length, tag])), /追加記録の長さ/);
  }
});

const day204Era = process.env.NAVIGATOR_TEST_SAVE_204_ERA;
test('day-204 export with ERA2 includes Yamato Line and the Fujisawa transfer', { skip: !day204Era }, async () => {
  const network = await importSave(new Blob([await readFile(day204Era)]));
  assert.equal(network.stations.length, 306);
  assert.equal(network.lines.length, 36);
  assert.equal(network.complexes.length, 245);
  assert.equal(network.lines.at(-1).name, '大和線');
  assert.ok(network.lines.at(-1).connected);
  const graph = buildGraph(network);
  assert.equal(graph.complexOf.get(514), graph.complexOf.get(743));
  const destination = graph.complexOf.get(network.lines.at(-1).stops.at(-1));
  assert.ok(searchRoutes(graph, graph.complexOf.get(514), destination).some(route =>
    route.legs.some(leg => leg.line.name === '大和線')));
});

test('service comparison distinguishes calls, passages and branches by station ID', () => {
  const edges = [{ id: 0, from: 0, to: 1 }, { id: 1, from: 1, to: 2 }, { id: 2, from: 2, to: 3 }];
  const lines = [{ stops: [0, 1, 2], path: [0, 2] }, { stops: [0, 20, 3], path: [0, 2, 4] }];
  const rows = new Map(compareServices(lines, edges, new Map([[20, 2]])).map(row => [row.id, row.calls]));
  assert.deepEqual(rows.get(1)[1], { positions: [], passes: true });
  assert.deepEqual(rows.get(2)[1], { positions: [2], passes: false });
  assert.deepEqual(rows.get(3)[0], { positions: [], passes: false });
});

test('transfer uses platform IDs and the complex index', () => {
  const lines = [line(0, [0, 1], [2]), line(1, [2, 3], [2])];
  assert.deepEqual(searchRoutes(buildGraph(makeNetwork(lines)), 0, 3), []);
  const graph = buildGraph(makeNetwork(lines, [[1, 2]]));
  const [route] = searchRoutes(graph, 0, 3);
  assert.equal(route.changes, 1);
  assert.deepEqual(route.legs.map(leg => leg.stops), [[0, 1], [2, 3]]);
  assert.equal(route.legs[1].walk, 180);
});

test('express has no boarding edge at skipped stations and one-way service is directional', () => {
  const graph = buildGraph(makeNetwork([
    line(0, [0, 1, 3], [1, 1]), line(1, [0, 3], [2], { oneWay: true, tph: [60, 6, 0] }),
  ]));
  assert.equal(searchRoutes(graph, 0, 3)[0].legs[0].line.id, 1);
  assert.equal(searchRoutes(graph, 3, 0)[0].legs[0].line.id, 0);
  assert.equal(searchRoutes(graph, 1, 3)[0].legs[0].line.id, 0);
  assert.deepEqual(searchRoutes(graph, 1, 3, { period: 2 }), []);
});

test('one-way loop rides through its seam without a new boarding', () => {
  const graph = buildGraph(makeNetwork([line(0, [0, 1, 2, 0], [1, 1, 1], { loop: true, oneWay: true })]));
  const [route] = searchRoutes(graph, 2, 1);
  assert.deepEqual(route.legs[0].stops, [2, 0, 1]);
  assert.equal(route.changes, 0);
});

test('search modes order distinct candidates and use a supported fare curve', () => {
  const fares = { ref: 'JP', scales: { '@': 7.3 }, income: 0.5, nodes: [[0, 1.55], [20, 4.1], [100, 14]] };
  const graph = buildGraph(makeNetwork([
    line(0, [0, 3], [12]),
    line(1, [0, 1], [1], { tph: [60, 6, 0] }),
    line(2, [1, 3], [1], { tph: [60, 6, 0] }),
  ], [], fares));
  assert.equal(searchRoutes(graph, 0, 3, { mode: 'fast' })[0].changes, 1);
  assert.equal(searchRoutes(graph, 0, 3, { mode: 'transfers' })[0].changes, 0);
  const routes = searchRoutes(graph, 0, 3, { mode: 'fare' });
  assert.equal(routes[0].km, 2);
  assert.ok(routes[0].fare < routes[1].fare);
  assert.equal(new Set(routes.map(r => r.key)).size, routes.length);
  assert.equal(fareAt(graph.fare, 20), 4.1 * 7.3);
});

test('rejects invalid signatures, invalid gzip and unsupported versions', async () => {
  await assert.rejects(importSave(new Blob(['not a save'])), /TWG1/);
  await assert.rejects(importSave(new Blob([Uint8Array.of(31, 139, 8, 0)])));
  const header = Buffer.from(JSON.stringify({ game: 'anitabuilder', format: 9 }));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  await assert.rejects(importSave(new Blob([gzipSync(Buffer.concat([Buffer.from('TWG1'), length, header]))])), /未対応/);
});

test('real day-195 export matches the verified game network', { skip: !fixture }, async () => {
  const bytes = await readFile(fixture);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '93277dc063fbe6b21891976224ad2ebd1a0ab5a71140071fb8c634375f4d0ac9');
  const network = await importSave(new Blob([bytes]));
  await assert.rejects(importSave(new Blob([bytes.subarray(0, -16)])));
  assert.equal(network.stations.length, 281);
  assert.equal(network.edges.length, 683);
  assert.equal(network.complexes.length, 229);
  assert.equal(network.lines.length, 32);
  assert.equal(network.groups.length, 7);
  assert.equal(network.links.length, 0);
  assert.deepEqual(network.lines[28].targetHeadway, [900, 0, 0]);
  assert.equal(network.lines.reduce((n, l) => n + l.hopKm.length, 0), 269);
  assert.ok(network.lines.every(l => l.connected));
  const topology = [
    network.stations.map(s => [s.id, s.name, Math.round(s.x * 1000), Math.round(s.y * 1000)]),
    network.lines.map(l => [l.id, l.name, l.color, l.group, l.stops, l.path, l.tph]),
    network.edges.map(e => [e.id, e.from, e.to]),
    network.complexes.map(c => c.members),
  ];
  assert.equal(createHash('sha256').update(JSON.stringify(topology)).digest('hex'),
    '81abf0d7d52dfd0c89f029496934edfa0dd264746570bc6ea311f6672f0a37a9');
  assert.deepEqual(network.complexes.find(c => c.id === 0).members, [0, 112, 142, 158, 307, 395, 500, 621, 704]);
  assert.deepEqual(network.lines[24].stops, [0, 14, 11, 54, 61, 501, 510, 513, 517, 104]);
  const graph = buildGraph(network);
  const routes = searchRoutes(graph, 0, 501);
  assert.ok(routes.length > 1);
  assert.equal(routes[0].changes, 0);
  assert.equal(graph.complexOf.get(routes[0].legs.at(-1).stops.at(-1)), 501);
  assert.ok(searchRoutes(graph, 43, 393).length);
});

test('searches a network of 2,000 stations', () => {
  const count = 2000;
  const ids = Array.from({ length: count }, (_, i) => i);
  const lines = [];
  for (let i = 0; i < count - 1; i += 25) {
    const stops = ids.slice(i, i + 26);
    lines.push(line(lines.length, stops, stops.slice(1).map(() => 1)));
  }
  const start = performance.now();
  const graph = buildGraph(makeNetwork(lines));
  const [route] = searchRoutes(graph, 0, count - 1, { limit: 1 });
  assert.equal(route.km, 1999);
  assert.equal(route.changes, 79);
  console.log('2000-station graph and query (ms):', Math.round(performance.now() - start));
});

test('day-204 export loads all station upgrades, links and the three new services', { skip: !day204 }, async () => {
  const bytes = await readFile(day204);
  const expectedTopologies = {
    '4d53af3e64d4c5bc807c112d371e01db221da311467507a1d62b2cfdd30e5a9b':
      '853269e5805a63211163b946ddf99c81f57a4b606504abf502fe215ffba1b6dd',
    'c69b5fa0ef3d9638c66bfd11c0a979fb386aea2aafce55c719548158d6a06366':
      'ecc380dbfb36da3109f45fb76a9d8053c78d0a055170dbeaf59a2f08c38ac0e6',
  };
  const expectedTopology = expectedTopologies[createHash('sha256').update(bytes).digest('hex')];
  assert.ok(expectedTopology, 'Use one of the two verified day-204 files');
  const network = await importSave(new Blob([bytes]));
  assert.equal(network.stations.length, 298);
  assert.equal(network.complexes.length, 239);
  assert.equal(network.edges.length, 718);
  assert.equal(network.lines.length, 35);
  assert.equal(network.stations[0].upgrades, 5);
  assert.deepEqual(network.links, [[24, 170]]);
  assert.deepEqual(network.lines.slice(-3).map(l => l.name), ['佐倉線', '練馬川越線', '狭山線']);
  assert.ok(network.lines.every(l => l.connected));
  const topology = [
    network.stations.map(s => [s.id, s.name, Math.round(s.x * 1000), Math.round(s.y * 1000)]),
    network.lines.map(l => [l.id, l.name, l.color, l.group, l.stops, l.path, l.tph]),
    network.edges.map(e => [e.id, e.from, e.to]),
    network.complexes.map(c => c.members),
  ];
  assert.equal(createHash('sha256').update(JSON.stringify(topology)).digest('hex'), expectedTopology);
  const graph = buildGraph(network);
  assert.equal(graph.complexOf.get(24), graph.complexOf.get(170));
  assert.deepEqual(graph.complexes.get(447).members, [447, 458, 461]);
  assert.equal(graph.stations.get(458).name, '新越谷駅前通り');
  assert.equal(graph.stationNames.get(447), graph.stations.get(447).name);
  const [koshigaya] = searchRoutes(graph, 0, graph.complexOf.get(499));
  assert.deepEqual(koshigaya.legs.map(leg => [leg.line.name, leg.stops[0], leg.stops.at(-1)]),
    [['越谷ライン', 159, 458], ['さいたまライン', 447, 499]]);
  const [sakura] = searchRoutes(graph, graph.complexOf.get(105), graph.complexOf.get(716));
  assert.deepEqual(sakura.legs[0].stops, network.lines[32].stops);
});
