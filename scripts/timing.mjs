import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { importSave } from '../src/save.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output?.toLowerCase().endsWith('.twtime')) {
  throw Error('使い方: node scripts/timing.mjs input.save output.twtime');
}

const assets = 'https://anita.garden/trainsworld/assets/';
async function officialFile(name, sha256) {
  const response = await fetch(assets + name, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('ゲームの公開ファイルを取得できません: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw Error('公式ゲームのファイルが照合時と異なります。');
  }
  return bytes;
}

const file = await readFile(input);
const network = await importSave(new Blob([file]));
const [worker, wasm] = await Promise.all([
  officialFile('clock.worker-hdc6c_8C.js', '7501195e2b85bf740ae7761d81d13c3e897a204dd8fd5476fe5d7f29672bf477'),
  officialFile('sim_bg-DuHzKt2z.wasm', '4f275c0bb7067a75d72deb7d681b9f9301c4b413ad8be67a8f75632cf67579ea'),
]);
const source = worker.toString('utf8');
// Use the checked WebAssembly interface without starting the game worker.
const adapter = source.slice(0, source.indexOf('const re=')) + '\nexport { R as init, n as Track };';
const { init, Track } = await import('data:text/javascript;base64,' + Buffer.from(adapter).toString('base64'));
await init({ module_or_path: wasm });

const data = file[0] === 31 && file[1] === 139 ? gunzipSync(file, { maxOutputLength: 96 * 1024 * 1024 }) : file;
const start = 8 + data.readUInt32LE(4);
const track = new Track(0, 0, true);
if (!track.load(data.subarray(start))) throw Error('公式ゲームでセーブを開けませんでした。');

const lines = [];
function matches(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
for (const line of network.lines) {
  if (!line.connected || !line.built || line.loop || line.mode === 'bus' ||
      !matches([...track.line_stops(line.id)], line.stops) ||
      !matches([...track.line_path(line.id)], line.path)) continue;
  const directions = [];
  for (const direction of line.oneWay ? [0] : [0, 1]) {
    const distance = [...track.line_stop_s(line.id, direction)];
    if (distance.length !== line.stops.length || !distance.every(Number.isFinite)) break;
    const km = distance.slice(1).map((meters, i) => (meters - distance[i]) / 1000);
    if (km.some(value => value < 0)) break;
    const periods = [];
    for (let period = 0; period < 3; period++) {
      const arrived = [...track.stop_times(line.id, direction, period)];
      const departed = [...track.stop_departures(line.id, direction, period)];
      if ([arrived, departed].some(values => values.length !== line.stops.length ||
          !values.every(Number.isFinite))) break;
      // The first interval includes the game's hold at the terminus.
      const ride = arrived.slice(1).map((time, i) => time - (i === 0 ? arrived[0] : departed[i]));
      const dwell = departed.map((time, i) => i === 0 || i === departed.length - 1 ? 0 : time - arrived[i]);
      if (ride.some(seconds => seconds <= 0) || dwell.some(seconds => seconds < 0)) break;
      periods.push({ ride, dwell });
    }
    if (periods.length !== 3) break;
    directions.push({ km, periods });
  }
  if (directions.length === (line.oneWay ? 1 : 2)) lines.push({ id: line.id, stops: line.stops, directions });
}
if (!lines.length) throw Error('停車順と所要時間が一致する系統がありません。');
const size = Buffer.alloc(4);
size.writeUInt32LE(file.length);
const wrapped = Buffer.concat([Buffer.from('TWN1'), size, file, Buffer.from(JSON.stringify({ version: 2, lines }))]);
await importSave(new Blob([wrapped]));
await writeFile(output, wrapped, { flag: 'wx' });
console.log(lines.length + '系統の方向別所要時間を追加しました。');
