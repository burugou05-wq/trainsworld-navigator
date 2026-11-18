import { importSave } from './save.mjs';
import { buildGraph, PERIODS, searchRoutes } from './router.mjs';
import { clockLabel, demandAt } from './serviceclock.mjs';
import { deleteSave, listSaves, putSave } from './storage.mjs';
import { makeMap } from './map.mjs';
import { compareServices } from './patterns.mjs';
import { matchingStation } from './savecompare.mjs';
import { language, localizePage, t } from './locale.mjs';

localizePage();

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
  if (mins < 60) return mins + t('分', " min");
  return Math.floor(mins / 60) + t('時間', " hr") + (mins % 60 ? t('', ' ') + mins % 60 + t('分', " min") : '');
};
const duration = seconds => seconds < 60 ? Math.round(seconds) + t('秒', " sec") : minutes(seconds);
// Trainsworld's built-in JPY display rate.
const YEN_PER_GAME_DOLLAR = 150;
const yenNumber = new Intl.NumberFormat(language, {
  style: 'currency', currency: 'JPY', maximumFractionDigits: 0,
});
const fareLabel = fare => {
  const amount = fare * YEN_PER_GAME_DOLLAR;
  return t('推定 ' + Math.round(amount).toLocaleString('ja-JP') + '円', 'Est. ' + yenNumber.format(amount));
};
const date = timestamp => new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };
const rail = line => {
  const color = element('i', undefined, 'color');
  color.style.setProperty('--route', line.color);
  const label = element('span');
  label.append(color, line.name || t('運行系統 ', "Service ") + line.id);
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
  $('theme').textContent = t('配色：', "Theme: ") + { auto: t('自動', "Auto"), light: t('ライト', "Light"), dark: t('ダーク', "Dark") }[theme];
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
  return (lines.length ? lines.slice(0, 3).join('・') + (lines.length > 3 ? t(' ほか', " and more") : '') : t('運行系統なし', "No services")) + t(' ｜駅ID ', " | Station ID ") + id;
}

$('journey').onsubmit = e => {
  e.preventDefault();
  $('query-status').textContent = '';
  if (!graph) {
    $('query-status').textContent = t('先にセーブファイルを読み込んでください。', "Import a save file first.");
    return;
  }
  const start = from.resolve(), end = to.resolve();
  if (!start || !end) {
    $('query-status').textContent = t('出発駅と到着駅を候補から選択してください。', "Choose a departure and arrival station from the suggestions.");
    $(start ? 'to' : 'from').focus();
    return;
  }
  if (start.id === end.id) {
    $('query-status').textContent = t('出発駅と到着駅が同じ駅です。', "Choose two different stations.");
    return;
  }
  const mode = new FormData(e.currentTarget).get('mode');
  const [hour, minute] = $('journey-time').value.split(':').map(Number);
  const time = hour * 3600 + minute * 60;
  const arriveBy = $('time-mode').value === 'arrive';
  routes = searchRoutes(graph, start.id, end.id, { mode, time, arriveBy });
  resultIndex = 0;
  lastQuery = { start, end, time, arriveBy, mode };
  if (!routes.length) $('query-status').textContent = t('到着できる経路がありません。', "No route found.");
  renderResults();
};

const timeParts = [
  ['seconds', t('乗車', "On train")],
  ['wait', t('待ち', "Waiting")],
  ['walk', t('構内移動', "Transfer walk")],
];

function journeyTimes(route) {
  return timeParts.map(([key, label]) => ({
    label, seconds: route.legs.reduce((total, leg) => total + leg[key], 0),
  }));
}

function timeComparison(route) {
  const section = element('section', undefined, 'time-comparison');
  section.setAttribute('aria-label', t('推定所要時間の内訳', "Estimated travel time breakdown"));
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
    const summary = Math.abs(difference) < 1 ? t('合計はほぼ同じ', "Similar total time") :
      t('合計 ', "Total: ") + duration(Math.abs(difference)) + (difference < 0 ? t('短い', " shorter") : t('長い', " longer"));
    const parts = deltas.filter(part => part.delta !== 0).map(({ label, delta }) =>
      label + ' ' + (delta < 0 ? '−' : '＋') + duration(Math.abs(delta)));
    section.append(element('p', t('経路', "Route ") + (routes.indexOf(reference) + 1) + t('との差　', ": ") + summary, 'comparison-total'));
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
  const endpoints = candidate => format(candidate.departure) + t(' 発 → ', " dep → ") + format(candidate.arrival) + t(' 着', " arr");
  const title = element('div', undefined, 'result-heading');
  title.append(element('h2', stationName(start.id) + ' → ' + stationName(end.id)),
    element('small', t(format(time) + (arriveBy ? 'までに到着' : 'に出発'),
      (arriveBy ? 'Arrive by ' : 'Depart at ') + format(time)) + t('・', ' · ') +
      PERIODS[demandAt(time)] + t('・推定', ' · estimated'), 'muted'));
  const comparison = saveComparison(lastQuery);
  if (!route) {
    region.append(title, comparison);
    return;
  }
  const tabs = element('div', undefined, 'candidates');
  routes.forEach((candidate, index) => {
    const b = button('', () => { resultIndex = index; renderResults(); $('results').querySelector('[aria-pressed=true]').focus(); }, 'candidate');
    b.setAttribute('aria-pressed', String(index === resultIndex));
    b.append(element('span', index ? t('経路 ', "Route ") + (index + 1) : { fast: arriveBy ? t('出発が最も遅い', "Latest departure") : t('最速', "Fastest"), transfers: t('乗換最少', "Fewest transfers"), fare: t('運賃最少（推定）', "Lowest estimated fare") }[mode]),
      element('strong', minutes(candidate.seconds)), element('span', endpoints(candidate)),
      element('span', t('乗換 ', "Transfers: ") + candidate.changes + t('回', "")));
    if (candidate.fare !== null) b.append(element('span', fareLabel(candidate.fare)));
    tabs.append(b);
  });
  const card = element('article', undefined, 'itinerary');
  const header = element('div', undefined, 'itinerary-top');
  header.append(element('strong', endpoints(route)),
    element('span', t('約 ', "About ") + minutes(route.seconds)),
    element('span', t('乗換 ', "Transfers: ") + route.changes + t('回　', " · ") + route.km.toFixed(1) + ' km' +
      (route.fare !== null ? '　' + fareLabel(route.fare) : '')),
    Object.assign(element('a', t('路線図で見る →', "Show on map →")), { href: '#map' }));
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
    if (!index) timeline.append(stop(first, route.departure, t('出発', "dep")));
    else {
      const previous = route.legs[index - 1];
      const last = previous.stops.at(-1);
      const transfer = last === first ? t('乗換', "Transfer") : t('構内乗換', "Change platforms");
      const info = element('details', undefined, 'transfer');
      const platforms = element('dl', undefined, 'transfer-platforms');
      for (const [label, line, id] of [[format(previous.arrival) + t(' 着', " arr"), previous.line, last],
        [format(leg.departure) + t(' 発', " dep"), leg.line, first]]) {
        const value = element('dd');
        value.append(rail(line), element('small', nameOf(id) + t('（ホームID ', " (platform ID ") + id + t('）', ")"), 'muted'));
        platforms.append(element('dt', label), value);
      }
      info.append(element('summary', transfer + t('（約 ', " (about ") + duration(leg.walk) + t('）　', ") · ") +
        format(previous.arrival) + t(' 着 → ', " arr → ") + format(leg.departure) + t(' 発', " dep")), platforms);
      timeline.append(info);
    }
    const body = element('div', undefined, 'timeline-leg');
    body.style.setProperty('--route', leg.line.color);
    const head = element('header');
    head.append(element('strong', leg.line.name),
      element('small', format(leg.departure) + t(' 発・', " dep · ") + PERIODS[leg.period]),
      element('small', t('待ち 約 ', "Wait about ") + duration(leg.wait) + t(' ／ 乗車 約 ', " / ride about ") + duration(leg.seconds)));
    if (leg.line.timing) head.append(element('small', t('乗車時間はゲーム計算値に基づく', "Ride time uses game calculations")));
    else if (leg.line.timingEstimate) head.append(element('small', t('乗車時間は配車数と運行頻度から補正', "Ride estimate adjusted for fleet size and service frequency")));
    if (!(leg.line.tph[demandAt(leg.ready)] > 0)) {
      head.append(element('small', format(leg.ready) + t(' は運行なし・次の運行まで待機', " has no service; wait for the next operating period")));
    }
    const details = element('details');
    const middle = leg.stops.slice(1, -1);
    details.append(element('summary', middle.length ?
      t('途中 ' + middle.length + '駅', middle.length + (middle.length === 1 ? ' intermediate stop' : ' intermediate stops')) :
      t('途中停車なし', 'No intermediate stops')));
    if (middle.length) {
      const stops = element('ul');
      stops.append(...middle.map((id, i) => element('li', format(leg.stopArrivals[i]) + t(' 着　', " arr · ") + stationName(id))));
      details.append(stops);
    }
    body.append(head, details);
    timeline.append(body, stop(leg.stops.at(-1), leg.arrival, t('着', "arr")));
  });
  card.append(header, timeComparison(route), timeline);
  region.append(title, comparison, tabs, card, element('p',
    t('発着時刻はゲーム内時刻での推定です。運行のない時間帯は運行再開まで待ちます。', "Times are in-game estimates. If a service is closed, the route waits until it resumes.") +
      (route.fare !== null ? t(' 運賃はセーブの料金設定から計算し、ゲーム内の換算で円表示しています。', " Fares use the save’s pricing and the game’s yen conversion.") : ''), 'legend'));
}

function saveComparison(query) {
  const baseSave = active;
  const baseGraph = graph;
  const panel = element('details', undefined, 'save-comparison');
  panel.append(element('summary', t('別のセーブと経路を比較', "Compare with another save")));
  const others = saves.filter(save => save.id !== baseSave.id);
  if (!others.length) {
    const prompt = element('p', t('比較するセーブをもう一つ読み込んでください。', "Import one more save to compare routes."));
    panel.append(prompt, Object.assign(element('a', t('セーブ管理へ', "Manage saves")), { href: '#saves' }));
    return panel;
  }
  const select = element('select');
  select.setAttribute('aria-label', t('比較するセーブ', "Save to compare"));
  select.append(Object.assign(element('option', t('比較先のセーブを選択', "Choose a save to compare")), { value: '' }));
  for (const save of others) {
    select.append(Object.assign(element('option', save.name + t('（', " (") + date(save.at) + t('）', ")")), { value: save.id }));
  }
  const content = element('div');
  panel.append(select, content);
  select.onchange = async () => {
    const chosen = select.value;
    const save = saves.find(item => item.id === chosen);
    content.replaceChildren();
    if (!save) return;
    content.textContent = t('比較先を読み込み中…', "Loading comparison save…");
    try {
      const network = await importSave(save.file);
      if (!panel.isConnected || select.value !== chosen) return;
      const otherGraph = buildGraph(network);
      showSaveComparison(content, baseSave, baseGraph, save, network, otherGraph, query);
    } catch (error) {
      if (panel.isConnected && select.value === chosen) content.textContent = t('比較先を読み込めません。', "Could not load the comparison save. ") + error.message;
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
  const inputs = [[start.id, t('比較先の出発駅', "Comparison departure station")], [end.id, t('比較先の到着駅', "Comparison arrival station")]].map(([id, caption]) => {
    const label = element('label', caption);
    const select = element('select');
    select.append(Object.assign(element('option', t('選択してください', "Choose a station")), { value: '' }));
    for (const [station, name] of stations) {
      select.append(Object.assign(element('option', names.get(name) === 1 ? name : name + t('（駅ID ', " (station ID ") + station + t('）', ")")),
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
      result.append(element('p', t('比較先の駅を選んでください。', "Choose the stations in the comparison save.")));
      return;
    }
    const [from, to] = inputs.map(input => Number(input.value));
    if (from === to) {
      result.append(element('p', t('比較先には異なる出発駅と到着駅を選んでください。', "Choose two different stations in the comparison save.")));
      return;
    }
    if (mode === 'fare' && (!leftGraph.fare || !rightGraph.fare)) {
      result.append(element('p', t('片方のセーブで運賃を計算できません。早い順か乗換が少ない順で検索してください。', "Fare estimates are unavailable for one save. Search by fastest route or fewest transfers.")));
      return;
    }
    const options = { time, arriveBy, mode };
    const [left] = searchRoutes(leftGraph, start.id, end.id, options);
    const [right] = searchRoutes(rightGraph, from, to, options);
    if (uniformEstimate) result.append(element('p', t('両方の所要時間を同じ推定方法で比較しています。', "Both saves use the same travel time estimation method."), 'muted'));
    if (left && right) {
      const seconds = Math.round(right.seconds - left.seconds);
      const changes = right.changes - left.changes;
      const elapsed = seconds ? duration(Math.abs(seconds)) + (seconds < 0 ? t('短縮', " shorter") : t('増加', " longer")) : t('所要時間差なし', "Same travel time");
      const transfers = changes ? t('乗換 ', "Transfers: ") + Math.abs(changes) + t('回', "") + (changes < 0 ? t('減', " fewer") : t('増', " more")) : t('乗換回数は同じ', "Same number of transfers");
      result.append(element('p', t('比較先は ', "Comparison: ") + elapsed + ' ／ ' + transfers, 'compare-delta'));
    } else if (left || right) {
      result.append(element('p', (left ? t('使用中', "Active save") : t('比較先', "Comparison save")) + t('のセーブで経路が見つかりました。', " has a route for this search."), 'compare-delta'));
    }
    const cards = element('div', undefined, 'compare-routes');
    function summary(save, route, index, origin, destination, label) {
      const card = element('section');
      card.append(element('h3', label + '　' + save.name),
        element('p', index.stationNames.get(origin) + ' → ' + index.stationNames.get(destination), 'muted'));
      if (!route) {
        card.append(element('p', t('この条件で利用できる経路なし', "No route for these search settings.")));
        return card;
      }
      card.append(element('p', clockLabel(route.departure, time) + t(' 発 → ', " dep → ") + clockLabel(route.arrival, time) + t(' 着', " arr")),
        element('strong', t('約 ', "About ") + minutes(route.seconds) + t('・乗換 ', " · transfers: ") + route.changes + t('回', "")));
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
    cards.append(summary(base, left, leftGraph, start.id, end.id, t('使用中', "Active save")),
      summary(other, right, rightGraph, from, to, t('比較先', "Comparison save")));
    result.append(cards);
  }
}

function renderDetail(target, type, id) {
  if (!active) return;
  target.replaceChildren();
  const detail = element('div', undefined, 'detail');
  if (type === 'line') {
    const line = lineOf(id);
    detail.append(element('h3', line.name || t('名称未設定の運行系統', "Unnamed service")));
    const group = active.network.groups.find(g => g.id === line.group);
    const facts = [line.stops.length + t('停車', " stops"), line.built ? t('建設済み', "Built") : t('計画中', "Planned"), line.oneWay ? t('片方向', "One-way") : t('両方向', "Both directions")];
    if (line.fast) facts.push(t('高速車両', "High-speed trains"));
    if (group) facts.push(group.name || t('路線グループ ', "Line group ") + group.id);
    if (line.symbol) facts.push(line.symbol);
    if (line.cars) facts.push(line.cars + t('両', " cars"));
    detail.append(element('p', facts.join(' ｜ '), 'muted'));
    detail.append(element('p', t('設定車両数　', "Assigned trains: ") +
      line.trains.map((count, i) => PERIODS[i] + ' ' + count + t('編成', " trains")).join(' ／ ') +
      t(' ｜ 設定停車時間 ', " | Set dwell time: ") + line.dwell + t('秒', " sec")));
    if (line.mode === 'bus') detail.append(element('p', t('バスの停留所はゲームが道路データから生成するため、経路検索の対象外です。', "Bus stops generated from road data are outside route search coverage.")));
    else if (!line.connected) detail.append(element('p', t('停車順に沿った経路を確認できませんでした。', "Could not verify a track path for these stops.")));
    if (line.speedLimit) detail.append(element('p', t('設定最高速度 ', "Set speed limit: ") + line.speedLimit + ' km/h'));
    if (line.tph) detail.append(element('p',
      (line.frequencySource === 'save' ? t('セーブ記録', "Recorded") : t('推定', "Estimated")) + t('の運行頻度（本/時）　', " frequency (trains/hr): ") +
      line.tph.map((rate, i) => PERIODS[i] + ' ' + rate.toFixed(1)).join(' ／ ')));
    if (line.targetHeadway) detail.append(element('p', t('保存された目標間隔（秒）　', "Saved target interval (seconds): ") +
      line.targetHeadway.map((n, i) => PERIODS[i] + ' ' + (n > 0 ? n : '—')).join(' ／ ')));
    if (group && active.network.lines.filter(member => member.group === group.id).length > 1) {
      detail.append(button(t('同じ路線グループの停車駅を比較', "Compare stopping patterns in this group"), () => renderGroup(target, group.id)));
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
    if (complex.members.length > 1) detail.append(element('p', complex.members.length + t('ホームの乗換駅', " platforms at this interchange"), 'muted'));
    const facilities = [t('折返し設備', "Turnback facility"), t('パーク＆ライド', "Park and ride"), t('待合室', "Waiting room"), t('待避線', "Passing track")];
    const platforms = element('ul');
    for (const station of complex.members.map(member => graph.stations.get(member))) {
      const equipment = facilities.filter((_, index) => station.upgrades & (1 << index));
      if (station.oneWay) equipment.push(t('片方向ホーム', "One-way platform"));
      if (station.port) equipment.push(t('船着場', "Ferry terminal"));
      platforms.append(element('li', station.name + ' #' + station.id + (equipment.length ? ' ｜ ' + equipment.join('・') : '')));
    }
    detail.append(platforms);
    const lines = [...graph.linesByComplex.get(id)];
    detail.append(element('p', lines.length ? t('停車する運行系統', "Services that stop here") : t('停車する運行系統なし', "No services stop here")));
    for (const line of lines) {
      const row = button('', () => renderDetail(target, 'line', line), 'record');
      row.append(rail(lineOf(line)));
      detail.append(row);
    }
    for (const [name, input] of [[t('ここから出発', "Depart from here"), from], [t('ここに到着', "Arrive here"), to]]) {
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
  detail.append(element('h3', group?.name || t('路線グループ ', "Line group ") + groupId));
  detail.append(element('p', t('数字は停車順です。「通過」は線路経路を確認できた駅、—はその他の駅です。', "Numbers indicate stop order. “Passes” means the service runs through the station; — means it does not."), 'muted'));
  const scroll = element('div', undefined, 'pattern-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', t('停車駅の比較表', "Stopping pattern comparison"));
  const table = element('table', undefined, 'pattern-table');
  const heading = element('thead');
  const columns = element('tr');
  columns.append(element('th', t('駅', "Station")));
  for (const line of lines) {
    const cell = element('th');
    cell.scope = 'col';
    const link = button('', () => renderDetail(target, 'line', line.id), 'record');
    link.append(rail(line));
    cell.append(link);
    if (!line.built) cell.append(element('small', t('計画中', "Planned"), 'muted'));
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
      row.append(element('td', positions.length ? positions.join('・') : passes ? t('通過', "Passes") : '—',
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
    results.append(element('p', t('先にセーブファイルを読み込んでください。', "Import a save file first."), 'muted'));
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
    results.append(element('h2', t('駅（', "Stations (") + stations.length + t('）', ")")),
      ...stations.slice(0, 60).map(s => record('station', s.id, s.label, detailLine(s.id))));
    if (stations.length > 60) results.append(element('p', t('駅名でさらに絞り込めます。', "Enter a more specific station name to narrow the results."), 'muted'));
  }
  if (lines.length) {
    const groups = active.network.groups.filter(group => lines.some(line => line.group === group.id) &&
      active.network.lines.filter(line => line.group === group.id).length > 1);
    if (groups.length) {
      results.append(element('h2', t('路線グループ', "Line groups")));
      for (const group of groups) {
        const members = active.network.lines.filter(line => line.group === group.id);
        const label = group.name || members.slice(0, 2).map(line => line.name).join('・');
        results.append(record('group', group.id, label, members.length + t('系統の停車駅を比較', " services to compare")));
      }
    }
    results.append(element('h2', t('運行系統（', "Services (") + lines.length + t('）', ")")),
      ...lines.map(line => record('line', line.id, rail(line),
        t(line.stops.length + '駅', line.stops.length + (line.stops.length === 1 ? ' stop' : ' stops')))));
  }
  if (!stations.length && !lines.length) results.append(element('p', t('該当する駅・路線がありません。', "No matching stations or lines."), 'muted'));
}
$('catalog-query').oninput = renderCatalog;

function renderSaves() {
  const list = $('save-list');
  list.replaceChildren(...saves.map(save => {
    const row = element('div', undefined, 'save-item');
    const info = element('span', save.name);
    info.append(element('small', date(save.at) + (active?.id === save.id ? t(' ｜ 使用中', " | Active") : '')));
    const select = button(t('使用する', "Use this save"), () => activate(save));
    select.disabled = active?.id === save.id;
    row.append(info, select, button(t('取り除く', "Remove"), async () => {
      try {
        if (!save.temporary) await deleteSave(save.id);
        saves = saves.filter(entry => entry.id !== save.id);
        if (active?.id === save.id) await activate(saves[0]);
        else renderSaves();
      } catch {
        $('import-status').textContent = t('ブラウザーから取り除けませんでした。', "Could not remove the save from this browser.");
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
    $('fare-option').title = fare.disabled ? t('適用できる運賃設定が確認できません。', "Fare estimates are unavailable for this save.") : t('距離別運賃から推定します。', "Estimated from distance-based fares.");
    if (fare.checked && fare.disabled) document.querySelector('[name=mode][value=fast]').checked = true;
    const box = $('active-save');
    box.replaceChildren();
    if (active) {
      const stats = element('dl', undefined, 'stats');
      const routeCount = new Set(loaded.lines.map(line => line.group ? 'group-' + line.group : 'line-' + line.id)).size;
      for (const [title, value] of [[t('駅', "Station"), loaded.stations.length], [t('路線', "Lines"), routeCount], [t('系統', "Services"), loaded.lines.length]]) {
        const pair = element('div');
        pair.append(element('dt', title), element('dd', value));
        stats.append(pair);
      }
      box.append(element('strong', active.name.replace(/\.save$/i, '')),
        element('small', (loaded.day === null ? '' : t('ゲーム内 ', "In-game day ") + loaded.day + t('日目 ｜ ', " | ")) + loaded.format),
        stats, element('small', t('取込 ', "Imported ") + date(active.at) + (active.temporary ? t('（一時）', " (temporary)") : '')));
      const busCount = loaded.lines.filter(line => line.mode === 'bus').length;
      const unresolved = loaded.lines.filter(l => l.built && !l.connected && l.mode !== 'bus').length;
      if (busCount) box.append(element('p', t('バス ', "") + busCount + t('系統は経路検索対象外', " bus services outside route search coverage"), 'muted'));
      if (unresolved) box.append(element('p', t('接続を確認できなかった系統 ' + unresolved + '件',
        'Services with unverified connections: ' + unresolved), 'muted'));
    } else box.append(element('p', t('セーブが読み込まれていません。', "No save loaded."), 'muted'));
    $('map-detail').replaceChildren();
    map.setup(loaded, graph);
    renderResults();
    renderCatalog();
    renderSaves();
  } catch (error) {
    $('import-status').textContent = t('切替に失敗しました。', "Could not switch saves. ") + error.message;
  }
}

async function importFiles(files) {
  if (importing || !files.length) return;
  importing = true;
  const messages = [];
  $('import-status').textContent = t('読み込み中…', "Importing…");
  let latest, latestNetwork;
  try {
    for (const file of files) {
      try {
        const network = await importSave(file);
        const id = globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random();
        const save = { id, name: file.name, file, at: Date.now() };
        try { await putSave(save); }
        catch { save.temporary = true; messages.push(file.name + t('：この画面でのみ使用できます。', ": available in this tab only.")); }
        saves = [save, ...saves];
        latest = save;
        latestNetwork = network;
      } catch (error) {
        messages.push(file.name + t('：', ': ') + error.message);
      }
    }
    if (latest) await activate(latest, latestNetwork);
    $('import-status').textContent = messages.join(t('　', ' · ')) || t('セーブを読み込みました。', "Save imported.");
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
  $('import-status').textContent = t('ブラウザーの保存領域を開けません。一時的な取り込みは利用できます。', "Browser storage is unavailable. You can still import saves for this session.");
}
