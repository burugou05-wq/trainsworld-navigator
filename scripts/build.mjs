import { cp, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
for (const target of ['web', 'chrome', 'firefox']) {
  const out = new URL('dist/' + target + '/', root);
  await mkdir(out, { recursive: true });
  for (const file of ['index.html', 'styles.css', 'src']) {
    await cp(new URL(file, root), new URL(file, out), { recursive: true });
  }
  if (target !== 'web') {
    await cp(new URL('extension/' + target + '.json', root), new URL('manifest.json', out));
    await cp(new URL('extension/' + target + '.js', root), new URL('background.js', out));
  }
  console.log('dist/' + target);
}
