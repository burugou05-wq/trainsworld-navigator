import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importSave } from '../src/save.mjs';

const endpoint = 'http://127.0.0.1:' + (process.env.NAVIGATOR_CDP ?? '9372');
const file = process.env.NAVIGATOR_TEST_SAVE;
if (!file) throw Error('Set NAVIGATOR_TEST_SAVE to the path of a Tokyo test save.');
const network = await importSave(new Blob([await readFile(file)]));
const stationCount = JSON.stringify(String(network.stations.length));
const active = `document.querySelector('#active-save .stats dd')?.textContent === ${stationCount}`;
const info = await (await fetch(endpoint + '/json/version')).json();
const open = async url => (await (await fetch(endpoint + '/json/new?' + url, { method: 'PUT' })).json()).webSocketDebuggerUrl;

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(), errors = [];
  let id = 0;
  socket.onmessage = ({ data }) => {
    const payload = JSON.parse(data);
    if (payload.method === 'Runtime.exceptionThrown') errors.push(payload.params.exceptionDetails.text);
    if (!payload.id) return;
    const { resolve, reject } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) reject(Error(payload.error.message));
    else resolve(payload.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 50; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Timed out: ' + expression);
  };
  return { send, evaluate, wait, errors, close: () => socket.close() };
}

async function loadAndSearch(url, width) {
  const tab = await connect(await open('about:blank'));
  const { send, evaluate, wait } = tab;
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait("document.readyState === 'complete' && !!document.querySelector('#save-files')");
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#save-files' });
  const otherSave = process.env.NAVIGATOR_COMPARE_SAVE;
  await send('DOM.setFileInputFiles', { nodeId, files: otherSave ? [otherSave, file] : [file] });
  await wait(active + " && document.querySelector('#import-status').textContent === 'セーブを読み込みました。'");
  if (network.day === 305) {
    if (otherSave) {
      await evaluate(`for (const [id, name] of [['from','東京'], ['to','横浜']]) {
        const input = document.getElementById(id);
        input.value = name;
        input.dispatchEvent(new Event('input'));
        document.getElementById(id + '-list').querySelector('[role=option]').click();
      }
      document.querySelector('#journey').requestSubmit();
      const panel = document.querySelector('.save-comparison');
      panel.open = true;
      const select = panel.querySelector('select');
      select.value = [...select.options].find(option => option.textContent.includes('day-277')).value;
      select.dispatchEvent(new Event('change'));`);
      await wait("document.querySelectorAll('.compare-routes section').length === 2");
      const compared = await evaluate("document.querySelector('.save-comparison').innerText");
      assert.match(compared, /day-277/);
      assert.match(compared, /短縮/);
      assert.match(compared, /東海道新幹線/);
      assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
    }
    await evaluate(`for (const [id, name] of [['from','名古屋'], ['to','東京']]) {
      const input = document.getElementById(id);
      input.value = name;
      input.dispatchEvent(new Event('input'));
      document.getElementById(id + '-list').querySelector('[role=option]').click();
    }
    document.querySelector('#journey').requestSubmit();`);
    await wait("document.querySelector('.timeline')?.textContent.includes('東海道新幹線')");
    const timeline = await evaluate("document.querySelector('.timeline').innerText");
    assert.match(timeline, /乗車 約 1時間30分/);
    assert.match(timeline, network.lines.some(line => line.timing) ? /ゲーム計算値/ : /配車数と運行頻度から補正/);
    assert.match(timeline, /09:39 着/);
    assert.deepEqual(tab.errors, []);
    tab.close();
    console.log('OK day 305', width, '09:39 着');
    return;
  }
  for (const [id, prefix, name] of [['from', '東', '東京'], ['to', '横', '横浜']]) {
    await evaluate(`document.getElementById('${id}').focus()`);
    await send('Input.insertText', { text: prefix });
    const point = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#${id}-list [role=option]')];
      const row = rows.find(item => item.firstChild.textContent === '${name}');
      if (!row) throw Error('station suggestion missing');
      row.scrollIntoView({ block: 'nearest' });
      const rect = row.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    assert.equal(await evaluate(`document.getElementById('${id}').value`), name);
    assert.equal(await evaluate(`document.getElementById('${id}-list').hidden`), true);
  }
  await evaluate("document.querySelector('#journey').requestSubmit()");
  await wait("document.querySelector('.timeline')?.textContent.includes('東海道線')");
  const result = await evaluate("document.querySelector('.itinerary-top').innerText");
  assert.match(result, /乗換 0回/);
  await evaluate("document.querySelector('#results details').open = true");
  assert.ok(await evaluate("document.querySelector('#results details li').textContent.length > 0"));
  await evaluate("document.querySelector('[value=fare]').click(); document.querySelector('#journey').requestSubmit()");
  assert.match(await evaluate("document.querySelector('.itinerary-top').innerText"), /推定 [\d,]+円/);
  assert.match(await evaluate("document.querySelector('.candidate').innerText"), /推定 [\d,]+円/);
  await evaluate("document.querySelector('[value=fast]').click(); document.querySelector('#journey').requestSubmit()");
  const timing = await evaluate("document.querySelector('.time-comparison').innerText");
  assert.match(timing, /乗車[\s\S]*待ち[\s\S]*構内移動/);
  assert.match(timing, /経路2との差/);
  await evaluate("document.querySelector('#time-mode').value = 'arrive'; document.querySelector('#journey-time').value = '21:00'; document.querySelector('#journey').requestSubmit()");
  assert.match(await evaluate("document.querySelector('.result-heading').innerText"), /中需要/);
  assert.match(await evaluate("document.querySelector('.itinerary-top').innerText"), /21:00 着/);
  await evaluate("document.querySelector('#time-mode').value = 'depart'; document.querySelector('#journey-time').value = '08:00'; document.querySelector('#journey').requestSubmit()");
  if (network.day === 204) {
    await evaluate(`const input = document.getElementById('to');
      input.value = '新三郷'; input.dispatchEvent(new Event('input'));
      document.querySelector('#journey').requestSubmit();`);
    const timeline = await evaluate("document.querySelector('.timeline').innerText");
    assert.match(timeline, /越谷\s+\d\d:\d\d 着\s+構内乗換/);
    assert.doesNotMatch(timeline, /新越谷駅前通り/);
    await evaluate("document.querySelector('.transfer').open = true");
    const platforms = await evaluate("document.querySelector('.transfer').innerText");
    assert.match(platforms, /越谷ライン[\s\S]*新越谷駅前通り（ホームID 458）/);
    assert.match(platforms, /さいたまライン[\s\S]*越谷（ホームID 447）/);
  }
  if (process.env.NAVIGATOR_SCREENSHOT && width > 600) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.NAVIGATOR_SCREENSHOT, Buffer.from(data, 'base64'));
  }
  await evaluate("location.hash = 'map'");
  await wait("!document.querySelector('#map').hidden && document.querySelector('canvas').width > 150");
  await evaluate("document.querySelector('#zoom-in').click(); location.hash = 'lines'");
  await wait("!document.querySelector('#lines').hidden");
  await evaluate(`{
    const input = document.querySelector('#catalog-query');
    input.value = '東海道'; input.dispatchEvent(new Event('input'));
    document.querySelector('#catalog-results button').click();
  }`);
  const comparison = await evaluate("document.querySelector('.pattern-table').innerText");
  assert.match(comparison, /東海道線特別快速/);
  assert.match(comparison, /通過/);
  assert.match(comparison, /—/);
  await evaluate("document.querySelector('.pattern-table button').click()");
  assert.ok(await evaluate("document.querySelector('#catalog-results ol li').textContent.length > 0"));
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  assert.deepEqual(tab.errors, []);
  await send('Page.reload');
  await wait(active);
  tab.close();
  console.log('OK', width, result.replaceAll('\n', ' '));
}

await loadAndSearch('http://127.0.0.1:4174/', 1200);
await loadAndSearch('http://127.0.0.1:4174/', 360);
if (process.env.NAVIGATOR_TEST_EXTENSION !== '0') {
  const browser = await connect(info.webSocketDebuggerUrl);
  const { id } = await browser.send('Extensions.loadUnpacked', { path: path.resolve('dist/chrome') });
  assert.match(id, /^[a-p]{32}$/);
  try {
    await loadAndSearch('chrome-extension://' + id + '/index.html', 365);
    const { targetInfos } = await browser.send('Target.getTargets');
    assert.ok(targetInfos.some(target => target.type === 'service_worker' && target.url.endsWith(id + '/background.js')));
    console.log('Chrome extension loaded; background and panel document verified.');
  } finally {
    await browser.send('Extensions.uninstall', { id });
    browser.close();
  }
}
