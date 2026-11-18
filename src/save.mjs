import { t } from './locale.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_INPUT = 32 * 1024 * 1024;
const MAX_EXPANDED = 96 * 1024 * 1024;
const RAD = Math.PI / 180;
const RADIUS = 6371008.8;
const STATION_FLAGS = 0x3f7;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  take(size) {
    if (size > this.bytes.length - this.pos) throw Error(t('セーブデータが途中で途切れています。', "The save file ended unexpectedly."));
    const start = this.pos;
    this.pos += size;
    return this.bytes.subarray(start, this.pos);
  }
  uint(max = 0xffffffff) {
    let value = 0;
    for (let factor = 1; factor <= 2 ** 49; factor *= 128) {
      const byte = this.take(1)[0];
      value += (byte & 127) * factor;
      if (value > max) break;
      if (byte < 128) return value;
    }
    throw Error(t('セーブデータに範囲外の数値があります。', "The save contains an out-of-range number."));
  }
  sint() {
    const value = this.uint(Number.MAX_SAFE_INTEGER);
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }
  many(read, max = 200000) {
    const size = this.uint(max);
    return Array.from({ length: size }, read);
  }
  string() {
    return utf8.decode(this.take(this.uint(16384)));
  }
  float() {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, this.uint());
    const number = view.getFloat32(0);
    if (!Number.isFinite(number)) throw Error(t('不正な浮動小数点数が含まれています。', "The save contains an invalid decimal number."));
    return number;
  }
  double() {
    const bytes = this.take(8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
    if (!Number.isFinite(value)) throw Error(t('座標原点が不正です。', "Invalid coordinate origin."));
    return value;
  }
}

async function decompress(blob) {
  if (blob.size > MAX_INPUT) throw Error(t('ファイルが大きすぎます（上限 32 MiB）。', "The file exceeds the 32 MiB limit."));
  const prefix = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (prefix[0] !== 31 || prefix[1] !== 139) return new Uint8Array(await blob.arrayBuffer());
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_EXPANDED) {
        await reader.cancel();
        throw Error(t('展開後のサイズが上限を超えています。', "The decompressed file exceeds the size limit."));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function importSave(blob) {
  if (await blob.slice(0, 4).text() === 'TWN1') {
    const prefix = await blob.slice(4, 8).arrayBuffer();
    if (prefix.byteLength !== 4) throw Error(t('所要時間付きセーブが途中で途切れています。', "The save with timing data ended unexpectedly."));
    const size = new DataView(prefix).getUint32(0, true);
    if (!size || size > MAX_INPUT || 8 + size >= blob.size || blob.size > MAX_INPUT + 8 * 1024 * 1024) {
      throw Error(t('所要時間付きセーブの長さが不正です。', "Invalid length for a save with timing data."));
    }
    const network = await readSave(blob.slice(8, 8 + size));
    const profile = JSON.parse(await blob.slice(8 + size).text());
    applyTiming(network, profile);
    return network;
  }
  return readSave(blob);
}

function applyTiming(network, profile) {
  if (profile?.version !== 2 || !Array.isArray(profile.lines)) throw Error(t('所要時間データの形式が不正です。', "Invalid timing data format."));
  const valid = (values, length, min, max) => Array.isArray(values) && values.length === length &&
    values.every(value => Number.isFinite(value) && value >= min && value <= max);
  for (const record of profile.lines) {
    const line = Number.isInteger(record?.id) ? network.lines[record.id] : undefined;
    const count = line?.stops.length;
    if (!line?.connected || line.timing || !Array.isArray(record.stops) || record.stops.length !== count ||
        !record.stops.every((id, i) => id === line.stops[i]) || !Array.isArray(record.directions) ||
        record.directions.length !== (line.oneWay ? 1 : 2) || !record.directions.every(d =>
          d && valid(d.km, count - 1, 0, 40075) && Array.isArray(d.periods) && d.periods.length === 3 &&
          d.periods.every(p => p && valid(p.ride, count - 1, 0.001, 86400) && valid(p.dwell, count, 0, 3600)))) {
      throw Error(t('所要時間データが停車順と一致しません。', "Timing data does not match the stopping pattern."));
    }
    line.timing = record.directions;
  }
}

async function readSave(blob) {
  const bytes = await decompress(blob);
  const reader = new Reader(bytes);
  if (utf8.decode(reader.take(4)) !== 'TWG1') throw Error(t('Trainsworld の TWG1 セーブを選んでください。', "Choose a Trainsworld TWG1 save file."));
  const size = new DataView(reader.take(4).buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  if (size > 16 * 1024 * 1024) throw Error(t('セーブの設定領域が大きすぎます。', "The save settings exceed the size limit."));
  const header = JSON.parse(utf8.decode(reader.take(size)));
  if (header?.game !== 'anitabuilder' || header.format !== 1) throw Error(t('未対応のゲームまたはセーブ形式です。', "Unsupported game or save format."));
  // The game's network fingerprint excludes this length-delimited save trailer.
  const end = bytes.length;
  if (end - reader.pos >= 8) {
    const tag = String.fromCharCode(...bytes.subarray(end - 4));
    if (tag === 'ERA1' || tag === 'ERA2') {
      const length = new DataView(bytes.buffer, bytes.byteOffset + end - 8, 4).getUint32(0, true);
      const trackEnd = end - 8 - length;
      if (trackEnd < reader.pos + 21) throw Error(t('セーブ末尾の追加記録の長さが不正です。', "Invalid length for the additional data at the end of the save."));
      reader.bytes = bytes.subarray(0, trackEnd);
    }
  }
  return readTrack(reader, header);
}

function positiveId(id, items, label) {
  if (!Number.isInteger(id) || id < 0 || id >= items.length) {
    throw Error(t(`存在しない${label}が参照されています。`, `The save refers to a missing ${label}.`));
  }
  return id;
}

function readTrack(r, header) {
  const format = utf8.decode(r.take(4));
  if (!['TWT4', 'TWT5', 'TWT6'].includes(format)) throw Error(t('この軌道形式には対応していません（対応形式 TWT4〜TWT6）。', "Unsupported track format. Supported versions are TWT4 through TWT6."));
  const frame = trackFrame(format, r.double(), r.double());
  const direction = r.uint(1);
  let x = 0, y = 0;
  const nodes = r.many((_, id) => {
    x += r.sint() / 1000;
    y += r.sint() / 1000;
    const level = r.sint();
    const flags = r.uint(0xffff);
    if ((flags & ~STATION_FLAGS) || (!(flags & 2) && (flags & 4))) {
      throw Error(t(`未確認の駅設定（駅ID ${id}、0x${flags.toString(16)}）が含まれています。`,
        `Unsupported station settings (station ID ${id}, flags 0x${flags.toString(16)}).`));
    }
    const platform = flags & 2 ? r.uint(5000) : 0;
    const name = (flags & 4) || platform === 1 ? r.string() : '';
    if (Math.abs(x) > 21e6 || Math.abs(y) > 25e6) throw Error(t('不正な駅座標が含まれています。', "The save contains invalid station coordinates."));
    return { id, x, y, level, flags, platform, name, port: platform === 1, named: Boolean(flags & 0x100),
      upgrades: (flags >> 4) & 15, oneWay: Boolean(flags & 0x200) };
  }, 30000);
  let a = 0;
  const edges = r.many((_, id) => {
    a += r.sint();
    const b = a + r.sint();
    const flags = r.uint();
    if (flags & ~0x47) throw Error(t(`未確認の線路設定（線路ID ${id}、0x${flags.toString(16)}）が含まれています。`,
      `Unsupported track settings (track ID ${id}, flags 0x${flags.toString(16)}).`));
    const from = nodes[positiveId(a, nodes, t('線路端点', "track endpoint"))], to = nodes[positiveId(b, nodes, t('線路端点', "track endpoint"))];
    let px = from.x, py = from.y;
    const points = [[px, py], ...r.many(() => {
      px += r.sint() / 1000;
      py += r.sint() / 1000;
      r.sint(); // Engineering geometry metadata.
      r.sint();
      return [px, py];
    }, 500), [to.x, to.y]];
    let km = 0;
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1], [x2, y2] = points[i];
      km += frame.distance(x1, y1, x2, y2) / 1000;
    }
    return { id, from: a, to: b, built: Boolean(flags & 4), highSpeed: Boolean(flags & 0x40), tracks: flags & 3, points, km };
  }, 80000);
  const lines = r.many((_, id) => {
    const name = r.string();
    const color = r.uint(0xffffff);
    const typeFields = [r.uint(), r.uint(), r.uint()];
    if (typeFields.some(Boolean)) throw Error(t('未照合の運行系統設定が含まれています。', "The save contains unsupported service settings."));
    const built = Boolean(r.uint(1));
    const trains = [r.uint(10000), r.uint(10000), r.uint(10000)];
    const dwell = r.uint(864000) / 10;
    const turnaround = r.uint(864000) / 10;
    const cars = r.uint(1000);
    let stop = 0;
    const stops = r.many(() => {
      stop += r.sint();
      if (!nodes[stop]?.platform) throw Error(t('停車駅が駅として登録されていません。', "A stopping point is missing from the station table."));
      return stop;
    }, 30000);
    let edge = 0;
    const path = r.many(() => {
      const code = r.uint();
      edge += (code & 1) ? -Math.floor(code / 4) - 1 : Math.floor(code / 4);
      const reverse = ((code >> 1) ^ code) & 1;
      positiveId(edge, edges, t('線路', "track"));
      return edge * 2 + reverse;
    });
    return {
      id, name, color: '#' + color.toString(16).padStart(6, '0'), built, trains, dwell, turnaround, cars,
      stops, path, group: 0, symbol: '', fast: false, oneWay: false, tph: null, targetHeadway: null,
    };
  }, 5000);
  const stations = nodes.filter(node => node.platform > 0);
  const links = [];
  const buildings = [];
  const groups = new Map();
  const sections = [];
  const lineAt = () => lines[positiveId(r.uint(), lines, t('運行系統', "service"))];
  const lineRows = read => r.many(() => read(lineAt()), lines.length);
  const seen = new Set();
  while (r.pos < r.bytes.length) {
    const section = String.fromCharCode(...r.take(4));
    if (seen.has(section)) throw Error(t('同じ追加領域が複数あります。', "The save contains a duplicate data section."));
    seen.add(section);
    sections.push(section);
    switch (section) {
      case 'LUI1': {
        r.uint();
        const symbols = r.many(() => r.string(), lines.length);
        symbols.forEach((symbol, i) => { lines[i].symbol = symbol; });
        break;
      }
      case 'LNK1':
        links.push(...r.many(() => {
          const from = r.uint(), to = r.uint();
          if (!nodes[from]?.platform || !nodes[to]?.platform) throw Error(t('乗換接続の駅IDが不正です。', "Invalid station ID in a transfer link."));
          return [from, to];
        }, 30000));
        break;
      case 'LAU1': lineRows(line => { line.targetHeadway = [r.uint(), r.uint(), r.uint()]; }); break;
      case 'LHS1': lineRows(line => { line.fast = true; }); break;
      case 'LOW1': lineRows(line => { line.oneWay = true; }); break;
      case 'LSL1': lineRows(line => { line.speedLimit = r.uint(2000); }); break;
      case 'LTW1': lineRows(line => { line.pairTracks = r.uint(); }); break;
      case 'LBS2':
        lineRows(line => {
          line.mode = 'bus';
          line.roadFlags = r.uint();
          let x = 0, y = 0;
          line.roadPoints = r.many(() => {
            x += r.sint() / 1000;
            y += r.sint() / 1000;
            return { x, y, kind: r.uint() };
          }, 30000);
        });
        break;
      case 'LFR2':
        r.many(() => {
          const station = nodes[r.uint()];
          if (!station?.port) throw Error(t('船着場の駅IDが不正です。', "Invalid station ID for a ferry terminal."));
          station.berth = [station.x + r.sint() / 1000, station.y + r.sint() / 1000];
        }, nodes.length);
        lineRows(line => {
          line.mode = 'ferry';
          line.waterFlags = r.uint();
          let x = 0, y = 0;
          line.waterPoints = r.many(() => {
            x += r.sint() / 1000;
            y += r.sint() / 1000;
            return { x, y, kind: r.uint(), speed: r.uint() / 1000 };
          }, 30000);
        });
        break;
      case 'BLD1':
        for (const building of r.many((_, id) => {
          const name = r.string();
          let x = 0, y = 0;
          const corners = r.many(() => {
            x += r.sint() / 1000;
            y += r.sint() / 1000;
            return [x, y];
          }, 1000);
          if (corners.length < 3) throw Error(t('駅施設の形状が不正です。', "Invalid station facility geometry."));
          return { id, name, corners };
        }, 5000)) buildings.push(building);
        break;
      case 'LRT1':
        lineRows(line => {
          line.tph = [r.float(), r.float(), r.float()];
          if (line.tph.some(rate => rate < 0 || rate > 10000)) throw Error(t('運行頻度が範囲外です。', "Service frequency is out of range."));
        });
        r.many(() => {
          lineAt(); r.uint(1); r.float();
          // Timing metadata also contains a raw 64-bit value.
          for (let i = 0; ; i++) {
            if (i >= 10) throw Error(t('運行時間の値が不正です。', "Invalid service timing value."));
            if (r.take(1)[0] < 128) break;
          }
          r.uint();
        }, lines.length * 2);
        break;
      case 'LGR1':
        lineRows(line => { line.group = r.uint(); });
        r.many(() => { const id = r.uint(); groups.set(id, { id, name: r.string() }); }, 5000);
        break;
      case 'LGL1':
        r.many(() => {
          const id = r.uint(), symbol = r.string(), color = '#' + r.uint(0xffffff).toString(16).padStart(6, '0');
          groups.set(id, { ...groups.get(id), id, symbol, color });
        }, 5000);
        break;
      case 'LPH1':
      case 'LSP1': lineRows(() => { r.float(); r.float(); r.float(); }); break;
      case 'LBD1': {
        const builtDays = limit => r.many(() => r.uint(), limit);
        const stationDays = builtDays(stations.length);
        const edgeDays = builtDays(edges.length);
        const lineDays = builtDays(lines.length);
        stations.filter(station => !station.port || (station.flags & 4)).forEach((station, i) => {
          station.builtDay = stationDays[i] ?? null;
        });
        edges.filter(edge => edge.built).forEach((edge, i) => { edge.builtDay = edgeDays[i] ?? null; });
        lines.filter(line => line.built).forEach((line, i) => { line.builtDay = lineDays[i] ?? null; });
        break;
      }
      default:
        throw Error(t(`未確認の追加領域（${JSON.stringify(section)}、展開後 ${r.pos - 4} バイト）で読み込みを停止しました。`,
          `Unsupported data section ${JSON.stringify(section)} at byte ${r.pos - 4} of the decompressed save.`));
    }
  }

  const stopIds = new Set(lines.filter(line => line.built).flatMap(line => line.stops));
  const stationsWithTrack = new Set(edges.filter(edge => edge.built).flatMap(edge => [edge.from, edge.to]));
  for (const station of stations) {
    [station.lon, station.lat] = frame.coordinates(station.x, station.y);
    station.built = station.port ? Boolean(station.flags & 4) : stationsWithTrack.has(station.id) || stopIds.has(station.id);
    if (!station.name) station.name = t(`名称未設定（駅ID ${station.id}）`, `Unnamed station (ID ${station.id})`);
  }
  for (const line of lines) {
    if (line.group && !groups.has(line.group)) groups.set(line.group, { id: line.group });
    if (line.mode === 'ferry') {
      line.built = Boolean(line.waterFlags & 1);
      prepareFerry(line, nodes, frame);
    }
    else if (line.mode !== 'bus') prepareLine(line, edges);
    else {
      line.built = Boolean(line.roadFlags & 1);
      line.connected = false;
    }
  }
  const complexes = stationComplexes(stations.filter(station => station.built), links, edges, buildings, frame);
  return {
    format: 'TWG1/' + format, sections, day: Number.isFinite(header.clock) ? Math.floor(header.clock / 86400) : null,
    start: typeof header.start === 'string' ? header.start : null, direction, stations, lines, links, edges,
    groups: [...groups.values()], complexes, buildings, fares: parseFares(header.fares),
  };
}

function trackFrame(format, lon, lat) {
  let coordinates, scaleAt;
  if (format === 'TWT6') {
    coordinates = (x, y) => [x / (RADIUS * RAD), Math.atan(Math.sinh(y / RADIUS)) / RAD];
    scaleAt = (_, y) => Math.cosh(y / RADIUS);
  } else if (format === 'TWT4') {
    const cos = Math.cos(lat * RAD);
    coordinates = (x, y) => [lon + x / (RADIUS * cos * RAD), lat + y / (RADIUS * RAD)];
    scaleAt = () => 1;
  } else {
    const phi = lat * RAD, n = Math.sin(phi);
    if (Math.abs(n) < 1e-8 || Math.abs(lat) >= 90) throw Error(t('旧形式の投影原点が不正です。', "Invalid projection origin for the legacy save format."));
    const origin = RADIUS * Math.cos(phi) / n;
    const factor = origin * Math.tan(Math.PI / 4 + phi / 2) ** n;
    coordinates = (x, y) => {
      const sign = Math.sign(n), rho = sign * Math.hypot(x, origin - y);
      return [lon + Math.atan2(sign * x, sign * (origin - y)) / n / RAD,
        (2 * Math.atan((factor / rho) ** (1 / n)) - Math.PI / 2) / RAD];
    };
    scaleAt = () => 1;
  }
  function distance(x, y, a, b) {
    if (format === 'TWT6') return Math.hypot(a - x, b - y) / scaleAt(x, (y + b) / 2);
    const [lon1, lat1] = coordinates(x, y), [lon2, lat2] = coordinates(a, b);
    return RADIUS * RAD * Math.hypot((lon2 - lon1) * Math.cos((lat1 + lat2) * RAD / 2), lat2 - lat1);
  }
  return {
    coordinates(x, y) {
      const [longitude, latitude] = coordinates(x, y);
      return [((longitude % 360 + 540) % 360) - 180, latitude];
    },
    scaleAt, distance,
  };
}

function prepareFerry(line, nodes, frame) {
  const portPoints = line.waterPoints.filter(point => point.kind === 1);
  line.connected = portPoints.length === line.stops.length && line.stops.length > 1 &&
    line.stops.every((id, index) => {
      const berth = nodes[id].berth;
      const point = portPoints[index];
      return berth && (!line.built || nodes[id].built) && Math.hypot(point.x - berth[0], point.y - berth[1]) < 0.01;
    });
  line.loop = line.stops.length > 2 && line.stops[0] === line.stops.at(-1);
  line.hopKm = [];
  line.hopSeconds = [];
  if (!line.connected) return;
  let meters = 0, seconds = 0;
  for (let i = 1; i < line.waterPoints.length; i++) {
    const a = line.waterPoints[i - 1], b = line.waterPoints[i];
    const distance = frame.distance(a.x, a.y, b.x, b.y);
    meters += distance;
    seconds += distance / (a.speed || b.speed || 8.889);
    if (b.kind === 1) {
      line.hopKm.push(meters / 1000);
      line.hopSeconds.push(seconds);
      meters = seconds = 0;
    }
  }
  line.frequencySource = line.tph ? 'save' : 'estimated';
  line.tph ??= line.targetHeadway?.map(interval => interval ? 3600 / interval : 0);
}

function prepareLine(line, edges) {
  let current = line.stops[0], next = 1;
  let km = 0;
  let track = [];
  const hops = [];
  const times = [];
  const reverseTimes = [];
  let followed = 0;
  for (const directed of line.path) {
    const edge = edges[Math.floor(directed / 2)];
    const from = directed % 2 ? edge.to : edge.from;
    const to = directed % 2 ? edge.from : edge.to;
    if (current !== from || (line.built && !edge.built)) break;
    followed++;
    current = to;
    km += edge.km;
    if (line.fast) track.push(edge);
    if (current === line.stops[next]) {
      hops.push(km);
      times.push(line.fast ? highSpeedRun(track, line.speedLimit) : runSeconds(km, false, line.speedLimit));
      if (line.fast) reverseTimes.push(highSpeedRun([...track].reverse(), line.speedLimit));
      next++;
      km = 0;
      track = [];
    }
  }
  line.connected = line.stops.length > 1 && next === line.stops.length &&
    followed === line.path.length && current === line.stops.at(-1);
  line.loop = line.stops.length > 2 && line.stops[0] === line.stops.at(-1);
  line.hopKm = line.connected ? hops : [];
  if (line.connected && line.fast && !line.oneWay && !line.loop && !line.targetHeadway &&
      line.trains[0] > 0 && line.tph?.[0] > 0) {
    const cycle = 3600 * line.trains[0] / line.tph[0];
    const running = cycle - 2 * (line.turnaround + (line.stops.length - 2) * line.dwell);
    const modeled = times.reduce((sum, seconds, i) => sum + seconds + reverseTimes[i], 0);
    const factor = running / modeled;
    // Exclude implausible cycles, such as frequency limits unrelated to fleet size.
    if (factor >= 1 && factor <= 2) {
      for (let i = 0; i < times.length; i++) {
        times[i] *= factor;
        reverseTimes[i] *= factor;
      }
      line.timingEstimate = 'fleet-cycle';
    }
  }
  line.hopSeconds = line.connected ? times : [];
  if (line.connected && line.fast) line.reverseHopSeconds = reverseTimes.reverse();
  if (!line.tph && line.connected) {
    const run = times.reduce((sum, seconds) => sum + seconds, 0);
    const cycle = (run + Math.max(0, line.stops.length - 2) * line.dwell + line.turnaround) * (line.oneWay ? 1 : 2);
    line.tph = line.trains.map(n => cycle > 0 ? 3600 * n / cycle : 0);
    line.frequencySource = 'estimated';
  } else {
    line.frequencySource = line.tph ? 'save' : 'unknown';
  }
}

export function runSeconds(km, fast = false, limit = 0) {
  const acceleration = 0.8;
  const maxSpeed = Math.min(fast ? 160 : 100, limit || Infinity) / 3.6;
  const meters = km * 1000, ramp = maxSpeed ** 2 / acceleration;
  return Math.max(1, meters < ramp ? 2 * Math.sqrt(meters / acceleration) :
    2 * maxSpeed / acceleration + (meters - ramp) / maxSpeed);
}

function highSpeedRun(edges, limit) {
  // Propagate braking and acceleration limits across track boundaries.
  const caps = edges.map(edge => Math.min(edge.highSpeed ? 320 : 160, limit || Infinity) / 3.6);
  const distances = edges.map(edge => edge.km * 1000);
  const speed = Array(edges.length + 1).fill(0);
  const acceleration = 0.5, braking = 0.9;
  for (let i = 0; i < edges.length; i++) {
    speed[i + 1] = Math.min(caps[i], caps[i + 1] ?? 0,
      Math.sqrt(speed[i] ** 2 + 2 * acceleration * distances[i]));
  }
  for (let i = edges.length - 1; i >= 0; i--) {
    speed[i] = Math.min(speed[i], Math.sqrt(speed[i + 1] ** 2 + 2 * braking * distances[i]));
  }
  let seconds = 0;
  for (let i = 0; i < edges.length; i++) {
    const start = speed[i], end = speed[i + 1], meters = distances[i];
    if (!meters) continue;
    const peak = Math.min(caps[i], Math.sqrt((2 * meters + start ** 2 / acceleration + end ** 2 / braking) /
      (1 / acceleration + 1 / braking)));
    const cruise = meters - (peak ** 2 - start ** 2) / (2 * acceleration) - (peak ** 2 - end ** 2) / (2 * braking);
    seconds += (peak - start) / acceleration + Math.max(0, cruise) / peak + (peak - end) / braking;
  }
  return Math.max(1, seconds);
}

function pointToSegment(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ratio = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - ratio * dx, y - a[1] - ratio * dy);
}

function separation(a, b, c, d) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return 0;
  return Math.min(pointToSegment(...a, c, d), pointToSegment(...b, c, d),
    pointToSegment(...c, a, b), pointToSegment(...d, a, b));
}

function platformSegment(station, edges, frame, extendTerminal = false) {
  const limit = station.platform * frame.scaleAt(station.x, station.y) / 2;
  const builtEdges = edges.filter(edge => edge.built);
  if (extendTerminal && builtEdges.length === 1) {
    // At a terminal the platform extends into the only adjoining track.
    const edge = builtEdges[0];
    const points = edge.from === station.id ? edge.points : [...edge.points].reverse();
    let remaining = limit * 2;
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i - 1], [a, b] = points[i];
      const distance = Math.hypot(a - x, b - y);
      if (distance > 0 && distance >= remaining) {
        return [points[0], [x + (a - x) * remaining / distance, y + (b - y) * remaining / distance]];
      }
      remaining -= distance;
    }
    return [points[0], points.at(-1)];
  }
  const rays = builtEdges.map(edge => {
    const point = edge.from === station.id ? edge.points[1] : edge.points.at(-2);
    const dx = point[0] - station.x, dy = point[1] - station.y;
    const size = Math.hypot(dx, dy) || 1;
    return [dx / size, dy / size];
  });
  const forward = rays[0] ?? [0, 0];
  const opposite = rays.reduce((best, ray) => {
    const dot = ([x, y]) => x * forward[0] + y * forward[1];
    return dot(ray) < dot(best) ? ray : best;
  }, forward.map(n => -n));
  return [forward, opposite].map(([dx, dy]) => [station.x + dx * limit, station.y + dy * limit]);
}

function stationComplexes(stations, links, edges, buildings, frame) {
  const parent = new Map(stations.map(station => [station.id, station.id]));
  const root = id => {
    while (parent.get(id) !== id) {
      id = parent.get(id);
    }
    return id;
  };
  const join = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const x = root(a), y = root(b);
    if (x !== y) parent.set(Math.max(x, y), Math.min(x, y));
  };
  for (const [a, b] of links) join(a, b);
  const byStation = new Map(stations.map(station => [station.id, []]));
  for (const edge of edges) {
    byStation.get(edge.from)?.push(edge);
    byStation.get(edge.to)?.push(edge);
  }
  const segments = stations.map(station => platformSegment(station, byStation.get(station.id), frame));
  const terminalSegments = stations.map((station, i) => {
    const adjacent = byStation.get(station.id);
    return adjacent.filter(edge => edge.built).length === 1 ?
      platformSegment(station, adjacent, frame, true) : segments[i];
  });
  const byX = stations.map((station, index) => ({ ...station, index })).sort((a, b) => a.x - b.x);
  const maxScale = Math.max(1, ...stations.map(s => frame.scaleAt(s.x, s.y)));
  const maxPlatform = Math.max(0, ...stations.map(s => s.platform));
  const horizon = Math.max(100, 2 * maxPlatform + 50) * maxScale;
  for (const [i, a] of byX.entries()) {
    for (let j = i + 1; j < byX.length && byX[j].x - a.x <= horizon; j++) {
      const b = byX[j];
      if (Math.abs(a.y - b.y) > horizon) continue;
      const scale = (frame.scaleAt(a.x, a.y) + frame.scaleAt(b.x, b.y)) / 2;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= 100 * scale ||
        separation(...segments[a.index], ...segments[b.index]) <= 50 * scale ||
        separation(...terminalSegments[a.index], ...terminalSegments[b.index]) <= 50 * scale) join(a.id, b.id);
    }
  }
  for (const { corners } of buildings) {
    const xmin = Math.min(...corners.map(p => p[0])), xmax = Math.max(...corners.map(p => p[0]));
    const ymin = Math.min(...corners.map(p => p[1])), ymax = Math.max(...corners.map(p => p[1]));
    const tolerance = 8 * frame.scaleAt((xmin + xmax) / 2, (ymin + ymax) / 2);
    let first;
    for (const [i, station] of stations.entries()) {
      const [a, b] = segments[i];
      if (Math.max(a[0], b[0]) < xmin - tolerance || Math.min(a[0], b[0]) > xmax + tolerance ||
          Math.max(a[1], b[1]) < ymin - tolerance || Math.min(a[1], b[1]) > ymax + tolerance) continue;
      const inside = ([x, y]) => {
        let hit = false;
        for (let j = 0, k = corners.length - 1; j < corners.length; k = j++) {
          const [u, v] = corners[j], [w, z] = corners[k];
          if ((v > y) !== (z > y) && x < u + (w - u) * (y - v) / (z - v)) hit = !hit;
        }
        return hit;
      };
      if (!inside(a) && !inside(b) &&
          !corners.some((p, j) => separation(a, b, p, corners[(j + 1) % corners.length]) <= tolerance)) continue;
      if (first === undefined) first = station.id;
      else join(first, station.id);
    }
  }
  const groups = new Map();
  for (const station of stations) {
    const id = root(station.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(station.id);
  }
  return [...groups.entries()].map(([id, members]) => ({ id, members }));
}

function parseFares(fares) {
  if (!fares || typeof fares !== 'object') return null;
  const { base, perKm, nodes, scales, basis, ref, hsr, transfer, income } = fares;
  if (basis !== 'usd' || !Number.isFinite(base) || !Number.isFinite(perKm) || base < 0 || perKm < 0) return null;
  if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 32 ||
    nodes.some((point, i) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
      point.some(n => n < 0) || (i > 0 && (point[0] <= nodes[i - 1][0] || point[1] < nodes[i - 1][1])))) return null;
  return { base, perKm, nodes, scales, basis, ref, hsr, transfer, income };
}
