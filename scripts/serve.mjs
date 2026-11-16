import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const base = process.argv.includes('--dist') ? '../dist/web/' : '../';
const mime = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', mjs: 'text/javascript; charset=utf-8' };
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!/^\/(index\.html|styles\.css|src\/[a-z-]+\.mjs)$/.test(pathname)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL(base + pathname.slice(1), import.meta.url));
    const ext = pathname.split('.').at(-1);
    res.writeHead(200, {
      'Content-Type': mime[ext], 'Content-Security-Policy': csp,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
const port = Number(process.env.NAVIGATOR_PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/'));
