import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importSave } from '../src/save.mjs';

const file = process.env.NAVIGATOR_TEST_SAVE;
const english = process.env.NAVIGATOR_TEST_LANG === 'en';
if (!file) throw Error('Set NAVIGATOR_TEST_SAVE.');
const network = await importSave(new Blob([await readFile(file)]));
const active = `document.querySelector('#active-save .stats dd')?.textContent === ${JSON.stringify(String(network.stations.length))}`;
const port = process.env.NAVIGATOR_BIDI ?? '9373';
const ws = new WebSocket('ws://127.0.0.1:' + port + '/session');
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const pending = new Map();
let id = 0;
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.type === 'error') request.reject(Error(message.error + ': ' + message.message));
  else request.resolve(message.result);
};
function run(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let extension;
try {
  const session = await run('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  ({ extension } = await run('webExtension.install', { extensionData: { type: 'path', path: path.resolve('dist/firefox') } }));
  assert.equal(extension, 'trainsworld-navigator@local.invalid');
  const { context } = await run('browsingContext.create', { type: 'tab' });
  const target = { context };
  async function evaluate(expression) {
    const result = await run('script.evaluate', { target, expression, awaitPromise: true });
    if (result.type === 'exception') throw Error(result.exceptionDetails.text);
    return result.result;
  }
  await run('browsingContext.setViewport', { context, viewport: { width: 365, height: 900 } });
  await run('browsingContext.navigate', { context, url: 'http://127.0.0.1:4174/', wait: 'complete' });
  const language = english ? 'en' : 'ja';
  if ((await evaluate('document.documentElement.lang')).value !== language) {
    await evaluate(`{
      const select = document.querySelector('#language');
      select.value = '${language}';
      select.dispatchEvent(new Event('change'));
    }`);
    for (let i = 0; i < 50; i++) {
      if ((await evaluate('document.documentElement.lang')).value === language) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.equal((await evaluate('document.documentElement.lang')).value, language);
  const { sharedId } = await evaluate("document.querySelector('#save-files')");
  await run('input.setFiles', { context, element: { sharedId }, files: [path.resolve(file)] });
  for (let i = 0; i < 50; i++) {
    if ((await evaluate(active)).value) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await evaluate(active)).value, true);
  const result = await evaluate(`for (const [id, text] of [['from','東京'],['to','横浜']]) {
    const input = document.getElementById(id); input.value = text; input.dispatchEvent(new Event('input'));
  }
  document.querySelector('#journey').requestSubmit();
  document.querySelector('.itinerary-top').innerText`);
  assert.match(result.value, english ? /Transfers: 0/ : /乗換 0回/);
  await run('browsingContext.close', { context });
  console.log('Firefox', session.capabilities.browserVersion, 'temporary MV3 installation and shared web UI:', result.value.replaceAll('\n', ' '));
} finally {
  try {
    if (extension) await run('webExtension.uninstall', { extension });
    await run('session.end');
  } finally {
    ws.close();
  }
}
