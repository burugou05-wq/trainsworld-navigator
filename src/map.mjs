import { t } from './locale.mjs';

export function makeMap(canvas, onSelect) {
  const ctx = canvas.getContext('2d');
  let network, graph, selected, width = 1, height = 1, zoom = 1, offsetX = 0, offsetY = 0;
  let fittedScale = 1, centerX = 0, centerY = 0, drag, stationPoints = [], lineSegments = [];

  function setup(data, indexes) {
    network = data;
    graph = indexes;
    selected = null;
    reset();
  }
  function reset() {
    zoom = 1;
    offsetX = offsetY = 0;
    draw();
  }
  function point(s) {
    const scale = fittedScale * zoom;
    return [(s.x - centerX) * scale + width / 2 + offsetX, (centerY - s.y) * scale + height / 2 + offsetY];
  }
  function draw() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const palette = getComputedStyle(canvas);
    const paper = palette.getPropertyValue('--surface').trim();
    const ink = palette.getPropertyValue('--strong').trim();
    const grid = palette.getPropertyValue('--line').trim();
    ctx.font = '12px sans-serif';
    if (!network?.stations.length) {
      ctx.fillStyle = ink;
      ctx.fillText(t('セーブを読み込むと路線図が表示されます。', 'Import a save to see the map.'), 18, 30);
      return;
    }
    const stations = network.stations.filter(s => s.built);
    if (!stations.length) return;
    const xmin = Math.min(...stations.map(s => s.x)), xmax = Math.max(...stations.map(s => s.x));
    const ymin = Math.min(...stations.map(s => s.y)), ymax = Math.max(...stations.map(s => s.y));
    centerX = (xmin + xmax) / 2;
    centerY = (ymin + ymax) / 2;
    fittedScale = Math.max(.000001, Math.min((width - 48) / (xmax - xmin || 1000), (height - 48) / (ymax - ymin || 1000)));
    ctx.strokeStyle = grid;
    ctx.globalAlpha = .45;
    ctx.beginPath();
    for (let x = 0; x < width; x += 36) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = 0; y < height; y += 36) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    lineSegments = [];
    function linePath(line, stops, highlight) {
      if (stops.length < 2) return;
      const xy = stops.map(id => point(graph.stations.get(id)));
      ctx.strokeStyle = line.color;
      ctx.globalAlpha = selected && !highlight ? .25 : .95;
      ctx.lineWidth = highlight ? 5.5 : 2.4;
      ctx.beginPath();
      ctx.moveTo(...xy[0]);
      for (let i = 1; i < xy.length; i++) {
        ctx.lineTo(...xy[i]);
        lineSegments.push({ id: line.id, a: xy[i - 1], b: xy[i] });
      }
      ctx.stroke();
    }
    for (const line of network.lines) if (line.built && line.connected) linePath(line, line.stops, false);
    for (const leg of selected?.legs ?? []) linePath(leg.line, leg.stops, true);
    ctx.globalAlpha = 1;
    stationPoints = stations.map(s => {
      const id = graph.complexOf.get(s.id);
      const interchange = graph.linesByComplex.get(id).size > 1;
      const [x, y] = point(s);
      return { x, y, id, s, interchange };
    }).filter(({ x, y }) => x >= 0 && x <= width && y >= 0 && y <= height);
    const labels = [];
    const drawnLabels = new Set();
    for (const p of stationPoints) {
      const { x, y, interchange } = p;
      ctx.beginPath();
      ctx.arc(x, y, interchange ? 3.4 : 1.9, 0, Math.PI * 2);
      ctx.fillStyle = paper;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = interchange ? 1.35 : .8;
      ctx.stroke();
      if (!(interchange || zoom >= 2.3) || drawnLabels.has(p.id)) continue;
      const name = graph.stationNames.get(p.id);
      const label = { x: x + 5, y: y - 5, w: ctx.measureText(name).width };
      if (labels.some(l => Math.abs(l.y - label.y) < 13 && l.x < label.x + label.w + 3 && label.x < l.x + l.w + 3)) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = paper;
      ctx.strokeText(name, label.x, label.y);
      ctx.fillStyle = ink;
      ctx.fillText(name, label.x, label.y);
      labels.push(label);
      drawnLabels.add(p.id);
    }
  }
  function resize(multiplier, x = width / 2, y = height / 2) {
    const old = zoom;
    zoom = Math.max(.75, Math.min(20, zoom * multiplier));
    offsetX += (x - width / 2 - offsetX) * (1 - zoom / old);
    offsetY += (y - height / 2 - offsetY) * (1 - zoom / old);
    draw();
  }
  function select(x, y) {
    let distance = 10, hit;
    for (const p of stationPoints) {
      const gap = Math.hypot(x - p.x, y - p.y);
      if (gap >= distance) continue;
      distance = gap;
      hit = p;
    }
    if (hit) return onSelect('station', hit.id);
    distance = 8;
    for (const { id, a, b } of lineSegments) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const ratio = Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const gap = Math.hypot(x - a[0] - ratio * dx, y - a[1] - ratio * dy);
      if (gap >= distance) continue;
      distance = gap;
      hit = id;
    }
    if (hit !== undefined) onSelect('line', hit);
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || drag) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, offsetX, offsetY, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (drag?.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    offsetX = drag.offsetX + dx;
    offsetY = drag.offsetY + dy;
    draw();
  });
  canvas.addEventListener('pointerup', e => {
    if (drag?.id !== e.pointerId) return;
    if (!drag.moved) select(e.offsetX, e.offsetY);
    drag = null;
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', e => {
    if (!network) return;
    e.preventDefault();
    resize(e.deltaY > 0 ? .83 : 1.2, e.offsetX, e.offsetY);
  }, { passive: false });
  new ResizeObserver(draw).observe(canvas);
  return { setup, reset, draw, resize, highlight(route) { selected = route; draw(); } };
}
