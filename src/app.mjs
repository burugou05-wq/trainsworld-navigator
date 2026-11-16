import { importSave } from './save.mjs';
import { buildGraph, PERIODS, searchRoutes } from './router.mjs';
import { clockLabel, demandAt } from './serviceclock.mjs';
import { deleteSave, listSaves, putSave } from './storage.mjs';
import { makeMap } from './map.mjs';
import { compareServices } from './patterns.mjs';
import { matchingStation } from './savecompare.mjs';

const $ = id => document.getElementById(id);
const element = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
};
const button = (text, action, className = 'secondary') => {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};
const normalize = text => text.normalize('NFKC').toLowerCase().trim().replace(/[ァ-ヶ]/g, letter =>
  String.fromCharCode(letter.charCodeAt(0) - 96));
const stationNameKey = text => normalize(text).replace(/駅$/, '');
const minutes = seconds => {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return mins + '分';
  return Math.floor(mins / 60) + '時間' + (mins % 60 ? mins % 60 + '分' : '');
};
const duration = seconds => seconds < 60 ? Math.round(seconds) + '秒' : minutes(seconds);
// Trainsworld's built-in JPY display rate.
const YEN_PER_GAME_DOLLAR = 150;
const yenNumber = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const fareLabel = fare => '推定 ' + yenNumber.format(fare * YEN_PER_GAME_DOLLAR) + '円';
const date = timestamp => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };
const rail = line => {
  const color = element('i', undefined, 'color');
  color.style.setProperty('--route', line.color);
  const label = element('span');
  label.append(color, line.name || '運行系統 ' + line.id);
  return label;
};

let saves = [], active, graph, stationIndex = [], routes = [], resultIndex = 0, lastQuery;
let activateToken = 0, importing = false;
const map = makeMap($('network-map'), (type, id) => renderDetail($('map-detail'), type, id));
const nameOf = id => graph.stations.get(id).name;
const stationName = id => graph.stationNames.get(graph.complexOf.get(id)) ?? nameOf(id);
const lineOf = id => active.network.lines[id];

function showPage() {
  const hash = location.hash.slice(1);
  const page = ['search', 'lines', 'map', 'saves'].includes(hash) ? hash : 'search';
  for (const panel of document.querySelectorAll('.page')) panel.hidden = panel.id !== page;
  for (const nav of document.querySelectorAll('[data-page]')) {
    if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  if (page === 'map') map.draw();
}
window.addEventListener('hashchange', showPage);
showPage();

const themes = ['auto', 'light', 'dark'];
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = '配色：' + { auto: '自動', light: 'ライト', dark: 'ダーク' }[theme];
  remember('theme', theme);
  map.draw();
}
setTheme(themes.includes(recall('theme')) ? recall('theme') : 'auto');
$('theme').onclick = () => setTheme(themes[(themes.indexOf(document.documentElement.dataset.theme) + 1) % themes.length]);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => map.draw());
$('zoom-in').onclick = () => map.resize(1.35);
$('zoom-out').onclick = () => map.resize(1 / 1.35);
$('zoom-reset').onclick = map.reset;

function candidates(query) {
  const q = normalize(query);
  if (!q) return [];
  return stationIndex.map(record => {
    const matches = record.names.filter(entry => entry.normal.includes(q) || entry.key === stationNameKey(q));
    if (!matches.length) return null;
    matches.sort((a, b) => score(a.normal, q) - score(b.normal, q) || a.name.length - b.name.length);
    const match = matches[0];
    return { ...record, label: match.name, rank: score(match.normal, q) };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'ja'));
}
function score(name, query) {
  if (name === query) return 0;
  if (stationNameKey(name) === stationNameKey(query)) return 1;
  return name.startsWith(query) ? 2 : 3;
}

function combo(input) {
  const list = $(input.id + '-list');
  const field = input.closest('.station-field');
  let choice = null, visible = [], current = -1;
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function set(value) {
    choice = value;
    input.value = value?.label ?? '';
    close();
  }
  function highlight(index) {
    current = index;
    [...list.children].forEach((child, i) => child.setAttribute('aria-selected', String(i === index)));
    const child = list.children[index];
    input.setAttribute('aria-activedescendant', child.id);
    child.scrollIntoView({ block: 'nearest' });
  }
  function show() {
    visible = candidates(input.value).slice(0, 9);
    current = -1;
    list.replaceChildren(...visible.map((item, i) => {
      const row = button(item.label, () => {
        input.focus({ preventScroll: true });
        set(item);
      }, 'station-option');
      row.tabIndex = -1;
      row.id = input.id + '-option-' + i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.append(element('small', detailLine(item.id)));
      // Keep the input focused until the candidate's click completes.
      row.addEventListener('mousedown', e => e.preventDefault());
      return row;
    }));
    if (!visible.length) return close();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  input.addEventListener('input', () => { choice = null; show(); });
  input.addEventListener('focus', show);
  field.addEventListener('focusout', e => {
    if (!field.contains(e.relatedTarget)) close();
  });
  input.addEventListener('keydown', e => {
    if (!(e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') || e.isComposing) return;
    if (e.key === 'Escape') return close();
    if (e.key === 'Enter') {
      if (list.hidden || current < 0) return;
      e.preventDefault();
      set(visible[current]);
      return;
    }
    e.preventDefault();
    if (list.hidden) show();
    if (visible.length) highlight((current + (e.key === 'ArrowDown' ? 1 : current < 0 ? visible.length : -1) + visible.length) % visible.length);
  });
  function resolve() {
    if (choice) return choice;
    const exact = candidates(input.value).filter(item => item.rank <= 1);
    if (exact.length !== 1) return null;
    set(exact[0]);
    return choice;
  }
  return { set, resolve, snapshot: () => ({ choice, value: input.value }), restore(saved) { set(saved.choice); input.value = saved.value; } };
}
const from = combo($('from')), to = combo($('to'));
$('swap').onclick = () => {
  const previous = from.snapshot();
  from.restore(to.snapshot());
  to.restore(previous);
};
function detailLine(id) {
  const lines = [...(graph.linesByComplex.get(id) ?? [])].map(lineId => lineOf(lineId).name);
  return (lines.length ? lines.slice(0, 3).join('・') + (lines.length > 3 ? ' ほか' : '') : '運行系統なし') + ' ｜駅ID ' + id;
}

$('journey').onsubmit = e => {
  e.preventDefault();
  $('query-status').textContent = '';
  if (!graph) {
    $('query-status').textContent = '先にセーブファイルを読み込んでください。';
    return;
  }
  const start = from.resolve(), end = to.resolve();
  if (!start || !end) {
    $('query-status').textContent = '出発駅と到着駅を候補から選択してください。';
    $(start ? 'to' : 'from').focus();
    return;
  }
  if (start.id === end.id) {
    $('query-status').textContent = '出発駅と到着駅が同じ駅です。';
    return;
  }
  const mode = new FormData(e.currentTarget).get('mode');
  const [hour, minute] = $('journey-time').value.split(':').map(Number);
  const time = hour * 3600 + minute * 60;
  const arriveBy = $('time-mode').value === 'arrive';
  routes = searchRoutes(graph, start.id, end.id, { mode, time, arriveBy });
  resultIndex = 0;
  lastQuery = { start, end, time, arriveBy, mode };
  if (!routes.length) $('query-status').textContent = '到着できる経路がありません。';
  renderResults();
};

const timeParts = [
  ['seconds', '乗車'],
  ['wait', '待ち'],
  ['walk', '構内移動'],
];

function journeyTimes(route) {
  return timeParts.map(([key, label]) => ({
    label, seconds: route.legs.reduce((total, leg) => total + leg[key], 0),
  }));
}

function timeComparison(route) {
  const section = element('section', undefined, 'time-comparison');
  section.setAttribute('aria-label', '推定所要時間の内訳');
  const times = journeyTimes(route);
  const list = element('dl', undefined, 'journey-times');
  for (const part of times) {
    const item = element('div');
    item.append(element('dt', part.label), element('dd', duration(part.seconds)));
    list.append(item);
  }
  section.append(list);
  const reference = routes.filter(other => other !== route).sort((a, b) => a.seconds - b.seconds)[0];
  if (reference) {
    const deltas = journeyTimes(reference).map((part, index) => ({
      label: part.label, delta: Math.round(times[index].seconds - part.seconds),
    }));
    const difference = Math.round(route.seconds - reference.seconds);
    const summary = Math.abs(difference) < 1 ? '合計はほぼ同じ' :
      '合計 ' + duration(Math.abs(difference)) + (difference < 0 ? '短い' : '長い');
    const parts = deltas.filter(part => part.delta !== 0).map(({ label, delta }) =>
      label + ' ' + (delta < 0 ? '−' : '＋') + duration(Math.abs(delta)));
    section.append(element('p', '経路' + (routes.indexOf(reference) + 1) + 'との差　' + summary, 'comparison-total'));
    if (parts.length) section.append(element('p', parts.join(' ／ '), 'muted'));
  }
  return section;
}

function renderResults() {
  const region = $('results');
  region.replaceChildren();
  $('search-empty').hidden = Boolean(active);
  const route = routes[resultIndex];
  map.highlight(route);
  if (!lastQuery) return;
  const { start, end, time, arriveBy, mode } = lastQuery;
  const format = seconds => clockLabel(seconds, time);
  const endpoints = candidate => format(candidate.departure) + ' 発 → ' + format(candidate.arrival) + ' 着';
  const title = element('div', undefined, 'result-heading');
  title.append(element('h2', stationName(start.id) + ' → ' + stationName(end.id)),
    element('small', format(time) + (arriveBy ? 'までに到着' : 'に出発') + '・' + PERIODS[demandAt(time)] + '・推定', 'muted'));
  const comparison = saveComparison(lastQuery);
  if (!route) {
    region.append(title, comparison);
    return;
  }
  const tabs = element('div', undefined, 'candidates');
  routes.forEach((candidate, index) => {
    const b = button('', () => { resultIndex = index; renderResults(); $('results').querySelector('[aria-pressed=true]').focus(); }, 'candidate');
    b.setAttribute('aria-pressed', String(index === resultIndex));
    b.append(element('span', index ? '経路 ' + (index + 1) : { fast: arriveBy ? '出発が最も遅い' : '最速', transfers: '乗換最少', fare: '運賃最少（推定）' }[mode]),
      element('strong', minutes(candidate.seconds)), element('span', endpoints(candidate)),
      element('span', '乗換 ' + candidate.changes + '回'));
    if (candidate.fare !== null) b.append(element('span', fareLabel(candidate.fare)));
    tabs.append(b);
  });
  const card = element('article', undefined, 'itinerary');
  const header = element('div', undefined, 'itinerary-top');
  header.append(element('strong', endpoints(route)),
    element('span', '約 ' + minutes(route.seconds)),
    element('span', '乗換 ' + route.changes + '回　' + route.km.toFixed(1) + ' km' +
      (route.fare !== null ? '　' + fareLabel(route.fare) : '')),
    Object.assign(element('a', '路線図で見る →'), { href: '#map' }));
  const timeline = element('div', undefined, 'timeline');
  function stop(id, time, action) {
    const row = element('div', undefined, 'timeline-stop');
    const label = element('span', stationName(id), 'stop-label');
    label.append(element('small', '　' + format(time) + ' ' + action, 'muted'));
    row.append(element('span', undefined, 'stop-dot'), label);
    return row;
  }
  route.legs.forEach((leg, index) => {
    const first = leg.stops[0];
    if (!index) timeline.append(stop(first, route.departure, '出発'));
    else {
      const previous = route.legs[index - 1];
      const last = previous.stops.at(-1);
      const transfer = last === first ? '乗換' : '構内乗換';
      const info = element('details', undefined, 'transfer');
      const platforms = element('dl', undefined, 'transfer-platforms');
      for (const [label, line, id] of [[format(previous.arrival) + ' 着', previous.line, last],
        [format(leg.departure) + ' 発', leg.line, first]]) {
        const value = element('dd');
        value.append(rail(line), element('small', nameOf(id) + '（ホームID ' + id + '）', 'muted'));
        platforms.append(element('dt', label), value);
      }
      info.append(element('summary', transfer + '（約 ' + duration(leg.walk) + '）　' +
        format(previous.arrival) + ' 着 → ' + format(leg.departure) + ' 発'), platforms);
      timeline.append(info);
    }
    const body = element('div', undefined, 'timeline-leg');
    body.style.setProperty('--route', leg.line.color);
    const head = element('header');
    head.append(element('strong', leg.line.name),
      element('small', format(leg.departure) + ' 発・' + PERIODS[leg.period]),
      element('small', '待ち 約 ' + duration(leg.wait) + ' ／ 乗車 約 ' + duration(leg.seconds)));
    if (leg.line.timing) head.append(element('small', '乗車時間はゲーム計算値に基づく'));
    else if (leg.line.timingEstimate) head.append(element('small', '乗車時間は配車数と運行頻度から補正'));
    if (!(leg.line.tph[demandAt(leg.ready)] > 0)) {
      head.append(element('small', format(leg.ready) + ' は運行なし・次の運行まで待機'));
    }
    const details = element('details');
    const middle = leg.stops.slice(1, -1);
    details.append(element('summary', middle.length ? '途中 ' + middle.length + '駅' : '途中停車なし'));
    if (middle.length) {
      const stops = element('ul');
      stops.append(...middle.map((id, i) => element('li', format(leg.stopArrivals[i]) + ' 着　' + stationName(id))));
      details.append(stops);
    }
    body.append(head, details);
    timeline.append(body, stop(leg.stops.at(-1), leg.arrival, '着'));
  });
  card.append(header, timeComparison(route), timeline);
  region.append(title, comparison, tabs, card, element('p',
    '発着時刻はゲーム内時刻での推定です。運行のない時間帯は運行再開まで待ちます。' +
      (route.fare !== null ? ' 運賃はセーブの料金設定から計算し、ゲーム内の換算で円表示しています。' : ''), 'legend'));
}

function saveComparison(query) {
  const baseSave = active;
  const baseGraph = graph;
  const panel = element('details', undefined, 'save-comparison');
  panel.append(element('summary', '別のセーブと経路を比較'));
  const others = saves.filter(save => save.id !== baseSave.id);
  if (!others.length) {
    const prompt = element('p', '比較するセーブをもう一つ読み込んでください。');
    panel.append(prompt, Object.assign(element('a', 'セーブ管理へ'), { href: '#saves' }));
    return panel;
  }
  const select = element('select');
  select.setAttribute('aria-label', '比較するセーブ');
  select.append(Object.assign(element('option', '比較先のセーブを選択'), { value: '' }));
  for (const save of others) {
    select.append(Object.assign(element('option', save.name + '（' + date(save.at) + '）'), { value: save.id }));
  }
  const content = element('div');
  panel.append(select, content);
  select.onchange = async () => {
    const chosen = select.value;
    const save = saves.find(item => item.id === chosen);
    content.replaceChildren();
    if (!save) return;
    content.textContent = '比較先を読み込み中…';
    try {
      const network = await importSave(save.file);
      if (!panel.isConnected || select.value !== chosen) return;
      const otherGraph = buildGraph(network);
      showSaveComparison(content, baseSave, baseGraph, save, network, otherGraph, query);
    } catch (error) {
      if (panel.isConnected && select.value === chosen) content.textContent = '比較先を読み込めません。' + error.message;
    }
  };
  return panel;
}

function showSaveComparison(target, base, baseGraph, other, network, otherGraph, query) {
  const { start, end, time, arriveBy, mode } = query;
  const controls = element('div', undefined, 'compare-stations');
  const result = element('div');
  result.setAttribute('aria-live', 'polite');
  const stations = [...otherGraph.stationNames.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ja'));
  const names = new Map();
  for (const [, name] of stations) names.set(name, (names.get(name) ?? 0) + 1);
  const inputs = [[start.id, '比較先の出発駅'], [end.id, '比較先の到着駅']].map(([id, caption]) => {
    const label = element('label', caption);
    const select = element('select');
    select.append(Object.assign(element('option', '選択してください'), { value: '' }));
    for (const [station, name] of stations) {
      select.append(Object.assign(element('option', names.get(name) === 1 ? name : name + '（駅ID ' + station + '）'),
        { value: String(station) }));
    }
    select.value = String(matchingStation(baseGraph, otherGraph, id) ?? '');
    select.onchange = compare;
    label.append(select);
    controls.append(label);
    return select;
  });
  const timingCoverage = net => net.lines.filter(line => line.timing).length;
  const uniformEstimate = (timingCoverage(base.network) > 0 || timingCoverage(network) > 0) &&
    (timingCoverage(base.network) !== base.network.lines.filter(line => line.built && line.connected).length ||
      timingCoverage(network) !== network.lines.filter(line => line.built && line.connected).length);
  const estimatedGraph = net => buildGraph({ ...net, lines: net.lines.map(line => ({ ...line, timing: undefined })) });
  const leftGraph = uniformEstimate ? estimatedGraph(base.network) : baseGraph;
  const rightGraph = uniformEstimate ? estimatedGraph(network) : otherGraph;
  target.replaceChildren(controls, result);
  compare();

  function compare() {
    result.replaceChildren();
    if (inputs.some(input => !input.value)) {
      result.append(element('p', '比較先の駅を選んでください。'));
      return;
    }
    const [from, to] = inputs.map(input => Number(input.value));
    if (from === to) {
      result.append(element('p', '比較先には異なる出発駅と到着駅を選んでください。'));
      return;
    }
    if (mode === 'fare' && (!leftGraph.fare || !rightGraph.fare)) {
      result.append(element('p', '片方のセーブで運賃を計算できません。早い順か乗換が少ない順で検索してください。'));
      return;
    }
    const options = { time, arriveBy, mode };
    const [left] = searchRoutes(leftGraph, start.id, end.id, options);
    const [right] = searchRoutes(rightGraph, from, to, options);
    if (uniformEstimate) result.append(element('p', '両方の所要時間を同じ推定方法で比較しています。', 'muted'));
    if (left && right) {
      const seconds = Math.round(right.seconds - left.seconds);
      const changes = right.changes - left.changes;
      const elapsed = seconds ? duration(Math.abs(seconds)) + (seconds < 0 ? '短縮' : '増加') : '所要時間差なし';
      const transfers = changes ? '乗換 ' + Math.abs(changes) + '回' + (changes < 0 ? '減' : '増') : '乗換回数は同じ';
      result.append(element('p', '比較先は ' + elapsed + ' ／ ' + transfers, 'compare-delta'));
    } else if (left || right) {
      result.append(element('p', (left ? '使用中' : '比較先') + 'のセーブで経路が見つかりました。', 'compare-delta'));
    }
    const cards = element('div', undefined, 'compare-routes');
    function summary(save, route, index, origin, destination, label) {
      const card = element('section');
      card.append(element('h3', label + '　' + save.name),
        element('p', index.stationNames.get(origin) + ' → ' + index.stationNames.get(destination), 'muted'));
      if (!route) {
        card.append(element('p', 'この条件で利用できる経路なし'));
        return card;
      }
      card.append(element('p', clockLabel(route.departure, time) + ' 発 → ' + clockLabel(route.arrival, time) + ' 着'),
        element('strong', '約 ' + minutes(route.seconds) + '・乗換 ' + route.changes + '回'));
      const list = element('ul');
      for (const leg of route.legs) {
        const row = element('li');
        const details = element('details');
        const heading = element('summary');
        heading.append(rail(leg.line));
        const stops = element('ol');
        for (const id of leg.stops) {
          stops.append(element('li', index.stationNames.get(index.complexOf.get(id)) ?? index.stations.get(id).name));
        }
        details.append(heading, stops);
        row.append(details);
        list.append(row);
      }
      card.append(list);
      return card;
    }
    cards.append(summary(base, left, leftGraph, start.id, end.id, '使用中'),
      summary(other, right, rightGraph, from, to, '比較先'));
    result.append(cards);
  }
}

function renderDetail(target, type, id) {
  if (!active) return;
  target.replaceChildren();
  const detail = element('div', undefined, 'detail');
  if (type === 'line') {
    const line = lineOf(id);
    detail.append(element('h3', line.name || '名称未設定の運行系統'));
    const group = active.network.groups.find(g => g.id === line.group);
    const facts = [line.stops.length + '停車', line.built ? '建設済み' : '計画中', line.oneWay ? '片方向' : '両方向'];
    if (line.fast) facts.push('高速車両');
    if (group) facts.push(group.name || '路線グループ ' + group.id);
    if (line.symbol) facts.push(line.symbol);
    if (line.cars) facts.push(line.cars + '両');
    detail.append(element('p', facts.join(' ｜ '), 'muted'));
    detail.append(element('p', '設定車両数　' +
      line.trains.map((count, i) => PERIODS[i] + ' ' + count + '編成').join(' ／ ') +
      ' ｜ 設定停車時間 ' + line.dwell + '秒'));
    if (line.mode === 'bus') detail.append(element('p', 'バスの停留所はゲームが道路データから生成するため、経路検索の対象外です。'));
    else if (!line.connected) detail.append(element('p', '停車順に沿った経路を確認できませんでした。'));
    if (line.speedLimit) detail.append(element('p', '設定最高速度 ' + line.speedLimit + ' km/h'));
    if (line.tph) detail.append(element('p',
      (line.frequencySource === 'save' ? 'セーブ記録' : '推定') + 'の運行頻度（本/時）　' +
      line.tph.map((rate, i) => PERIODS[i] + ' ' + rate.toFixed(1)).join(' ／ ')));
    if (line.targetHeadway) detail.append(element('p', '保存された目標間隔（秒）　' +
      line.targetHeadway.map((n, i) => PERIODS[i] + ' ' + (n > 0 ? n : '—')).join(' ／ ')));
    if (group && active.network.lines.filter(member => member.group === group.id).length > 1) {
      detail.append(button('同じ路線グループの停車駅を比較', () => renderGroup(target, group.id)));
    }
    const list = element('ol');
    for (const station of line.stops) {
      const li = element('li');
      const complex = graph.complexOf.get(station);
      li.append(complex === undefined ? element('span', nameOf(station)) :
        button(stationName(station), () => renderDetail(target, 'station', complex), 'record'));
      list.append(li);
    }
    detail.append(list);
  } else {
    const complex = graph.complexes.get(id);
    detail.append(element('h3', stationName(id)));
    if (complex.members.length > 1) detail.append(element('p', complex.members.length + 'ホームの乗換駅', 'muted'));
    const facilities = ['折返し設備', 'パーク＆ライド', '待合室', '待避線'];
    const platforms = element('ul');
    for (const station of complex.members.map(member => graph.stations.get(member))) {
      const equipment = facilities.filter((_, index) => station.upgrades & (1 << index));
      if (station.oneWay) equipment.push('片方向ホーム');
      if (station.port) equipment.push('船着場');
      platforms.append(element('li', station.name + ' #' + station.id + (equipment.length ? ' ｜ ' + equipment.join('・') : '')));
    }
    detail.append(platforms);
    const lines = [...graph.linesByComplex.get(id)];
    detail.append(element('p', lines.length ? '停車する運行系統' : '停車する運行系統なし'));
    for (const line of lines) {
      const row = button('', () => renderDetail(target, 'line', line), 'record');
      row.append(rail(lineOf(line)));
      detail.append(row);
    }
    for (const [name, input] of [['ここから出発', from], ['ここに到着', to]]) {
      detail.append(button(name, () => { input.set({ id, label: stationName(id) }); location.hash = 'search'; }));
    }
  }
  target.append(detail);
}

function renderGroup(target, groupId) {
  const { network } = active;
  const group = network.groups.find(item => item.id === groupId);
  const lines = network.lines.filter(line => line.group === groupId);
  const detail = element('div', undefined, 'detail');
  detail.append(element('h3', group?.name || '路線グループ ' + groupId));
  detail.append(element('p', '数字は停車順です。「通過」は線路経路を確認できた駅、—はその他の駅です。', 'muted'));
  const scroll = element('div', undefined, 'pattern-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '停車駅の比較表');
  const table = element('table', undefined, 'pattern-table');
  const heading = element('thead');
  const columns = element('tr');
  columns.append(element('th', '駅'));
  for (const line of lines) {
    const cell = element('th');
    cell.scope = 'col';
    const link = button('', () => renderDetail(target, 'line', line.id), 'record');
    link.append(rail(line));
    cell.append(link);
    if (!line.built) cell.append(element('small', '計画中', 'muted'));
    columns.append(cell);
  }
  heading.append(columns);
  const body = element('tbody');
  for (const { id, calls } of compareServices(lines, network.edges, graph.complexOf)) {
    const row = element('tr');
    const name = element('th', stationName(id));
    name.scope = 'row';
    row.append(name);
    for (const { positions, passes } of calls) {
      row.append(element('td', positions.length ? positions.join('・') : passes ? '通過' : '—',
        positions.length ? 'pattern-stop' : 'muted'));
    }
    body.append(row);
  }
  table.append(heading, body);
  scroll.append(table);
  detail.append(scroll);
  target.replaceChildren(detail);
}

function renderCatalog() {
  const results = $('catalog-results');
  results.replaceChildren();
  if (!active) {
    results.append(element('p', '先にセーブファイルを読み込んでください。', 'muted'));
    return;
  }
  const q = normalize($('catalog-query').value);
  const detail = element('div');
  function record(type, id, label, sub) {
    const row = button('', () => {
      row.after(detail);
      if (type === 'group') renderGroup(detail, id);
      else renderDetail(detail, type, id);
    }, 'record');
    row.append(label, element('small', '　' + sub, 'muted'));
    return row;
  }
  const lines = active.network.lines.filter(line =>
    !q || normalize([line.name, line.symbol, active.network.groups.find(g => g.id === line.group)?.name].join(' ')).includes(q));
  const stations = q ? candidates(q) : [];
  if (stations.length) {
    results.append(element('h2', '駅（' + stations.length + '）'),
      ...stations.slice(0, 60).map(s => record('station', s.id, s.label, detailLine(s.id))));
    if (stations.length > 60) results.append(element('p', '駅名でさらに絞り込めます。', 'muted'));
  }
  if (lines.length) {
    const groups = active.network.groups.filter(group => lines.some(line => line.group === group.id) &&
      active.network.lines.filter(line => line.group === group.id).length > 1);
    if (groups.length) {
      results.append(element('h2', '路線グループ'));
      for (const group of groups) {
        const members = active.network.lines.filter(line => line.group === group.id);
        const label = group.name || members.slice(0, 2).map(line => line.name).join('・');
        results.append(record('group', group.id, label, members.length + '系統の停車駅を比較'));
      }
    }
    results.append(element('h2', '運行系統（' + lines.length + '）'),
      ...lines.map(line => record('line', line.id, rail(line), line.stops.length + '駅')));
  }
  if (!stations.length && !lines.length) results.append(element('p', '該当する駅・路線がありません。', 'muted'));
}
$('catalog-query').oninput = renderCatalog;

function renderSaves() {
  const list = $('save-list');
  list.replaceChildren(...saves.map(save => {
    const row = element('div', undefined, 'save-item');
    const info = element('span', save.name);
    info.append(element('small', date(save.at) + (active?.id === save.id ? ' ｜ 使用中' : '')));
    const select = button('使用する', () => activate(save));
    select.disabled = active?.id === save.id;
    row.append(info, select, button('取り除く', async () => {
      try {
        if (!save.temporary) await deleteSave(save.id);
        saves = saves.filter(entry => entry.id !== save.id);
        if (active?.id === save.id) await activate(saves[0]);
        else renderSaves();
      } catch {
        $('import-status').textContent = 'ブラウザーから取り除けませんでした。';
      }
    }));
    return row;
  }));
}

async function activate(save, network) {
  const token = ++activateToken;
  try {
    const loaded = save ? network ?? await importSave(save.file) : null;
    if (token !== activateToken) return;
    active = save ? { ...save, network: loaded } : null;
    graph = loaded ? buildGraph(loaded) : null;
    stationIndex = graph ? [...graph.complexes.values()].map(({ id, members }) => ({
      id, names: [...new Set([stationName(id), ...members.map(nameOf)])].map(name => ({
        name, normal: normalize(name), key: stationNameKey(name),
      })),
    })) : [];
    remember('active-save', active?.id ?? '');
    from.set(null);
    to.set(null);
    routes = [];
    lastQuery = undefined;
    $('query-status').textContent = '';
    const fare = $('fare-option').querySelector('input');
    fare.disabled = !graph?.fare;
    $('fare-option').title = fare.disabled ? '適用できる運賃設定が確認できません。' : '距離別運賃から推定します。';
    if (fare.checked && fare.disabled) document.querySelector('[name=mode][value=fast]').checked = true;
    const box = $('active-save');
    box.replaceChildren();
    if (active) {
      const stats = element('dl', undefined, 'stats');
      const routeCount = new Set(loaded.lines.map(line => line.group ? 'group-' + line.group : 'line-' + line.id)).size;
      for (const [title, value] of [['駅', loaded.stations.length], ['路線', routeCount], ['系統', loaded.lines.length]]) {
        const pair = element('div');
        pair.append(element('dt', title), element('dd', value));
        stats.append(pair);
      }
      box.append(element('strong', active.name.replace(/\.save$/i, '')),
        element('small', (loaded.day === null ? '' : 'ゲーム内 ' + loaded.day + '日目 ｜ ') + loaded.format),
        stats, element('small', '取込 ' + date(active.at) + (active.temporary ? '（一時）' : '')));
      const busCount = loaded.lines.filter(line => line.mode === 'bus').length;
      const unresolved = loaded.lines.filter(l => l.built && !l.connected && l.mode !== 'bus').length;
      if (busCount) box.append(element('p', 'バス ' + busCount + '系統は経路検索対象外', 'muted'));
      if (unresolved) box.append(element('p', '接続を確認できなかった系統 ' + unresolved + '件', 'muted'));
    } else box.append(element('p', 'セーブが読み込まれていません。', 'muted'));
    $('map-detail').replaceChildren();
    map.setup(loaded, graph);
    renderResults();
    renderCatalog();
    renderSaves();
  } catch (error) {
    $('import-status').textContent = '切替に失敗しました。' + error.message;
  }
}

async function importFiles(files) {
  if (importing || !files.length) return;
  importing = true;
  const messages = [];
  $('import-status').textContent = '読み込み中…';
  let latest, latestNetwork;
  try {
    for (const file of files) {
      try {
        const network = await importSave(file);
        const id = globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random();
        const save = { id, name: file.name, file, at: Date.now() };
        try { await putSave(save); }
        catch { save.temporary = true; messages.push(file.name + '：この画面でのみ使用できます。'); }
        saves = [save, ...saves];
        latest = save;
        latestNetwork = network;
      } catch (error) {
        messages.push(file.name + '：' + error.message);
      }
    }
    if (latest) await activate(latest, latestNetwork);
    $('import-status').textContent = messages.join('　') || 'セーブを読み込みました。';
    if (messages.length || location.hash === '#saves') location.hash = 'saves';
  } finally {
    importing = false;
  }
}
$('save-files').onchange = e => {
  void importFiles([...e.currentTarget.files]);
  e.currentTarget.value = '';
};
for (const pick of document.querySelectorAll('.pick')) pick.onclick = () => $('save-files').click();
window.addEventListener('dragover', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  $('drop').classList.add('drag');
});
window.addEventListener('dragleave', e => { if (!e.relatedTarget) $('drop').classList.remove('drag'); });
window.addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  $('drop').classList.remove('drag');
  location.hash = 'saves';
  void importFiles([...e.dataTransfer.files]);
});
try {
  const stored = await listSaves();
  saves = [...new Map([...stored, ...saves].map(save => [save.id, save])).values()].sort((a, b) => b.at - a.at);
  if (!activateToken && !importing) await activate(saves.find(save => save.id === recall('active-save')) ?? saves[0]);
} catch {
  $('import-status').textContent = 'ブラウザーの保存領域を開けません。一時的な取り込みは利用できます。';
}
