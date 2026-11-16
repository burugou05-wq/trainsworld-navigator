import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import path from 'node:path';

const socket = createConnection({ host: '127.0.0.1', port: Number(process.env.NAVIGATOR_MARIONETTE ?? 2829) });
const pending = new Map();
let buffer = Buffer.alloc(0), id = 0;
const ready = new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(58);
      if (colon < 0) break;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length <= colon + size) break;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size));
      buffer = buffer.subarray(colon + 1 + size);
      if (message.marionetteProtocol) resolve();
      else {
        const [, number, error, value] = message;
        const request = pending.get(number);
        pending.delete(number);
        if (error) request.reject(Error(error.message));
        else request.resolve(value);
      }
    }
  });
});
function run(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    const payload = JSON.stringify([0, id, method, params]);
    socket.write(Buffer.byteLength(payload) + ':' + payload);
  });
}

let extension;
await ready;
try {
  await run('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
  const installed = await run('Addon:Install', { path: path.resolve('dist/firefox'), temporary: true });
  extension = installed.value ?? installed;
  assert.equal(extension, 'trainsworld-navigator@local.invalid');
  await run('Marionette:SetContext', { value: 'chrome' });
  const execute = async (script, args = []) => (await run('WebDriver:ExecuteScript', { script, args })).value;
  const sidebar = await execute('return [...SidebarController.sidebars.keys()]');
  const sidebarId = sidebar.find(key => key.includes('trainsworld-navigator'));
  assert.ok(sidebarId, 'Extension sidebar not registered: ' + JSON.stringify(sidebar));
  await execute('SidebarController.show(arguments[0]);', [sidebarId]);
  for (let i = 0; i < 50; i++) {
    const open = await execute(`const browser = document.getElementById("sidebar");
      const panel = browser.contentDocument?.querySelector("browser");
      return { open: SidebarController.isOpen, id: SidebarController.currentID,
        location: panel?.currentURI?.spec };`);
    if (open.open && open.id === sidebarId && /^moz-extension:\/\/.+\/index\.html$/.test(open.location ?? '')) {
      console.log('Firefox native sidebar:', sidebarId, open.location);
      break;
    }
    if (i === 49) throw Error('Firefox sidebar did not open: ' + JSON.stringify(open));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await execute('SidebarController.hide();');
  assert.equal(await execute('return SidebarController.isOpen;'), false);
} finally {
  try {
    if (extension) await run('Addon:Uninstall', { id: extension });
    await run('WebDriver:DeleteSession');
  } finally {
    socket.end();
  }
}
