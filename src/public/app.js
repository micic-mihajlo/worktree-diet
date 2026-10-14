const $ = (selector, root = document) => root.querySelector(selector);

const elements = {
  roots: $('#roots'),
  refresh: $('#refresh'),
  status: $('#scan-status'),
  readyValue: $('#ready-value'),
  readyUnit: $('#ready-unit'),
  heroDetail: $('#hero-detail'),
  hero: $('.hero'),
  meter: $('#meter'),
  meterLabels: $('#meter-labels'),
  allCount: $('#all-count'),
  notice: $('#notice'),
  error: $('#error'),
  loading: $('#loading'),
  list: $('#worktree-list'),
  empty: $('#empty'),
  count: $('#result-count'),
  inspector: $('#inspector'),
  warnings: $('#warnings'),
  warningList: $('#warning-list'),
  search: $('#search'),
  sort: $('#sort'),
  dialog: $('#confirm-dialog'),
  confirmDescription: $('#confirm-description'),
  confirmList: $('#confirm-list'),
  confirmMove: $('#confirm-move'),
  rowTemplate: $('#row-template'),
};

const states = ['likely-inactive', 'review', 'recent'];
const stateLabels = { 'likely-inactive': 'Ready to clean', review: 'Needs review', recent: 'Recently active' };
const categoryLabels = { dependencies: 'Dependencies', buildOutput: 'Build output', caches: 'Cache' };

let report;
let mutationToken;
let selectedPath;
let activeFilter = 'all';
let descending = true;
let ambiguousPaths = new Set();

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Meter geometry: must match --cell and --gap on .hero in styles.css.
const CELL_GAP = 3;
const CELL_PITCH = 10 + CELL_GAP;
const meterLayers = ['likely-inactive', 'review', 'recent', 'freed'];
const meterWords = { 'likely-inactive': 'ready', review: 'review', recent: 'recent', freed: 'freed' };
const meter = {
  columns: 0,
  scale: 0, // largest total seen this session, so space you free shows up as freed cells
  ends: null, // cumulative column end per layer, as last drawn
  revealed: false,
  labels: Object.fromEntries(meterLayers.map((layer) => {
    const label = document.createElement('span');
    label.className = 'meter-label';
    elements.meterLabels.append(label);
    return [layer, label];
  })),
};
let shownReadyBytes = null;
let readyAnimation = 0;
let introPending = true;

// Three significant figures reads better than fixed decimals: 512 MB, 4.98 GB, 14.2 GB.
function byteParts(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return [String(Number(value.toFixed(digits))), units[unit]];
}
const formatBytes = (bytes) => byteParts(bytes).join(' ');

const daysSince = (time) => Math.floor(Math.max(0, Date.now() - time) / 86_400_000);
function age(time) {
  if (time === null) return 'Unknown';
  const days = daysSince(time);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} ${days < 548 ? 'year' : 'years'} ago`;
}
const dateTime = (time) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(time);
const plural = (count, noun, nouns = `${noun}s`) => `${count} ${count === 1 ? noun : nouns}`;

const baseName = (path) => path.split('/').filter(Boolean).at(-1) ?? path;
const selected = () => report?.worktrees.find((record) => record.path === selectedPath);

// "storefront · storefront-checkout-v2" — the folder only when it differs from the repository.
function shortLocation(record) {
  const repository = baseName(record.repositoryPath);
  const folder = baseName(record.path);
  return folder === repository ? repository : `${repository} · ${folder}`;
}
// Fall back to the full path when another worktree would read identically.
const locationLine = (record) => ambiguousPaths.has(record.path) ? record.path : shortLocation(record);

function findAmbiguousPaths(records) {
  const key = (record) => `${record.branch}\n${shortLocation(record)}`;
  const counts = new Map();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return new Set(records.filter((record) => counts.get(key(record)) > 1).map((record) => record.path));
}

// Nested generated folders can share a name (packages/web/dist, packages/docs/dist), so show where each lives.
const folderLabel = (record, path) => path.startsWith(`${record.path}/`) ? path.slice(record.path.length + 1) : baseName(path);

function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}

function showNotice(message, kind = '') {
  elements.notice.textContent = message;
  elements.notice.className = `notice ${kind}`;
  elements.notice.hidden = !message;
}

function stateTotals() {
  const totals = Object.fromEntries(states.map((state) => [state, { bytes: 0, count: 0 }]));
  for (const record of report.worktrees) {
    totals[record.activity.state].bytes += record.generatedAllocatedBytes;
    totals[record.activity.state].count += 1;
  }
  return totals;
}

function verdict(record) {
  const days = record.lastCommitAt === null ? null : daysSince(record.lastCommitAt);
  if (record.activity.state === 'likely-inactive') return `Clean, and nobody has committed here in ${days} days. Its generated folders are safe to move — reinstall if you come back.`;
  if (record.status === 'dirty') return 'Has uncommitted changes. Moving generated folders won’t touch them, but you may still be working here.';
  if (record.activity.state === 'review') {
    if (days === null) return 'Couldn’t read the last commit time, so there’s no evidence either way. Check it before cleaning.';
    if (record.generatedAllocatedBytes === 0) return 'Nothing generated here to reclaim.';
    if (record.status !== 'clean') return 'Couldn’t read Git status, so uncommitted work can’t be ruled out. Check it before cleaning.';
    return `Last commit was ${days} days ago — past this week, but not idle long enough to call inactive. Worth a quick look first.`;
  }
  return 'Committed to this week — expect to reinstall dependencies if you clean it.';
}

function visibleRecords() {
  const query = elements.search.value.trim().toLowerCase();
  return (report?.worktrees ?? [])
    .filter((record) => activeFilter === 'all' || record.activity.state === activeFilter)
    .filter((record) => !query || `${record.branch} ${record.repositoryPath} ${record.path}`.toLowerCase().includes(query))
    .sort((left, right) => (descending ? -1 : 1) * (left.generatedAllocatedBytes - right.generatedAllocatedBytes));
}

function renderHero() {
  const totals = stateTotals();
  const ready = totals['likely-inactive'];
  elements.heroDetail.innerHTML = ready.count
    ? `sitting in <strong>${plural(ready.count, 'worktree')}</strong> that look abandoned, out of ${formatBytes(report.generatedAllocatedBytes)} of generated files across ${plural(report.worktrees.length, 'worktree')}.`
    : `Nothing looks abandoned yet — ${formatBytes(report.generatedAllocatedBytes)} generated across ${plural(report.worktrees.length, 'worktree')}.`;
  elements.allCount.textContent = String(report.worktrees.length);
  for (const state of states) $(`#${state}-count`).textContent = String(totals[state].count);

  meter.scale = Math.max(meter.scale, report.generatedAllocatedBytes);
  const bytes = { ...Object.fromEntries(states.map((state) => [state, totals[state].bytes])), freed: meter.scale - report.generatedAllocatedBytes };
  elements.meter.setAttribute('aria-label', meterLayers.filter((layer) => bytes[layer] > 0).map((layer) => `${formatBytes(bytes[layer])} ${meterWords[layer]}`).join(', '));
  drawMeter(bytes, ready.bytes);
}

// Whole cells per layer (largest remainder), with at least one cell for anything non-zero.
function apportionCells(values, cells) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || !cells) return values.map(() => 0);
  const exact = values.map((value) => value / total * cells);
  const counts = exact.map(Math.floor);
  const order = exact.map((value, index) => [value - Math.floor(value), index]).sort((left, right) => right[0] - left[0]);
  for (let remaining = cells - counts.reduce((sum, count) => sum + count, 0), index = 0; remaining > 0; remaining -= 1, index += 1) counts[order[index % order.length][1]] += 1;
  for (const [index, value] of values.entries()) {
    if (value <= 0 || counts[index] > 0) continue;
    const donor = counts.indexOf(Math.max(...counts));
    if (counts[donor] > 1) { counts[donor] -= 1; counts[index] = 1; }
  }
  return counts;
}

// Each layer spans from the meter's left edge to its cumulative end and is scaled, never resized, so
// every change is a compositor-only transform. Stepping by whole cells keeps the motion pixel-true.
function drawMeter(bytes, readyBytes) {
  if (!meter.columns) return;
  const counts = apportionCells(meterLayers.map((layer) => bytes[layer]), meter.columns);
  const width = meter.columns * CELL_PITCH;
  const ends = {}; let end = 0;
  meterLayers.forEach((layer, index) => { end += counts[index]; ends[layer] = end; });
  const intro = introPending && !reducedMotion.matches;
  const moved = meter.ends ? Math.max(...meterLayers.map((layer) => Math.abs(ends[layer] - meter.ends[layer]))) : 0;
  const duration = intro ? 0 : Math.min(1200, Math.max(450, moved * 45));
  elements.hero.style.setProperty('--duration', `${duration}ms`);

  let start = 0;
  for (const [index, layer] of meterLayers.entries()) {
    const element = $(`.layer.${layer}`, elements.meter);
    element.style.setProperty('--steps', String(Math.max(1, Math.abs(ends[layer] - (meter.ends?.[layer] ?? 0)))));
    element.style.transform = `scaleX(${ends[layer] ? (ends[layer] * CELL_PITCH - CELL_GAP / 2) / width : 0})`;
    const label = meter.labels[layer];
    const span = counts[index] * CELL_PITCH - CELL_GAP;
    label.innerHTML = `<i class="dot ${layer}"></i><b>${formatBytes(bytes[layer])}</b> ${meterWords[layer]}`;
    label.style.width = `${Math.max(0, span)}px`;
    label.style.setProperty('--steps', String(Math.max(1, Math.abs(start - (label.start ?? 0)))));
    label.style.transform = `translateX(${start * CELL_PITCH}px)`;
    if (intro) label.style.setProperty('--reveal-delay', `${Math.round(1100 * start / meter.columns)}ms`);
    label.classList.toggle('is-empty', counts[index] === 0);
    label.classList.toggle('is-hidden', span < 96);
    label.start = start;
    start = ends[layer];
  }
  meter.ends = ends;

  if (intro) {
    introPending = false;
    // Reveal cell by cell, and count the hero up while the "ready" cells light up.
    const sweep = 1100;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      elements.hero.style.setProperty('--sweep', `${sweep}ms`);
      elements.hero.classList.add('is-revealed');
      // Labels fade in as the sweep reaches their segment; afterwards they respond immediately.
      setTimeout(() => { for (const label of Object.values(meter.labels)) label.style.removeProperty('--reveal-delay'); }, sweep);
    }));
    animateReady(0, readyBytes, Math.max(350, sweep * ends['likely-inactive'] / meter.columns));
  } else {
    if (introPending) { introPending = false; elements.hero.classList.add('is-revealed'); }
    animateReady(shownReadyBytes ?? readyBytes, readyBytes, duration);
  }
}

function setReady(bytes) {
  const [value, unit] = byteParts(bytes);
  elements.readyValue.textContent = value;
  elements.readyUnit.textContent = unit;
  elements.readyValue.style.width = '';
  elements.readyValue.classList.remove('is-counting');
  shownReadyBytes = bytes;
}

// Counts in the larger value's unit so the unit never flickers. While counting, the digits sit in a
// box sized once to the widest string, on their own layer, so each tick re-lays-out and repaints only them.
function animateReady(from, to, duration) {
  cancelAnimationFrame(readyAnimation);
  if (from === to || !duration || reducedMotion.matches) { setReady(to); return; }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const [largest, unit] = byteParts(Math.max(from, to));
  const divisor = 1024 ** units.indexOf(unit);
  const digits = largest.includes('.') ? largest.split('.')[1].length : 0;
  const text = (bytes) => (bytes / divisor).toFixed(digits);
  // Start on the next frame: measuring now would force a layout in the middle of rendering.
  readyAnimation = requestAnimationFrame((startedAt) => {
    elements.readyUnit.textContent = unit;
    elements.readyValue.style.width = '';
    elements.readyValue.textContent = text(Math.max(from, to));
    elements.readyValue.style.width = `${elements.readyValue.getBoundingClientRect().width}px`;
    elements.readyValue.classList.add('is-counting');
    let last = '';
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      if (progress === 1) { setReady(to); return; }
      const next = text(from + (to - from) * progress);
      if (next !== last) { elements.readyValue.textContent = next; last = next; }
      readyAnimation = requestAnimationFrame(tick);
    };
    tick(startedAt);
  });
}

new ResizeObserver(([entry]) => {
  const columns = Math.floor((entry.contentRect.width + CELL_GAP) / CELL_PITCH);
  if (columns === meter.columns) return;
  meter.columns = columns;
  meter.ends = null;
  elements.hero.style.setProperty('--columns', String(columns));
  elements.hero.classList.add('is-instant');
  if (report) renderHero();
  requestAnimationFrame(() => elements.hero.classList.remove('is-instant'));
}).observe(elements.hero);

function renderInspector(record) {
  if (!record) {
    elements.inspector.innerHTML = '<p class="inspector-empty">Select a worktree to see what would move to Trash.</p>';
    return;
  }

  const [value, unit] = byteParts(record.generatedAllocatedBytes);
  const largestFolder = Math.max(1, ...record.generatedDirectories.map((directory) => directory.allocatedBytes));
  const folders = record.generatedDirectories
    .toSorted((left, right) => right.allocatedBytes - left.allocatedBytes)
    .map((directory) => `
      <li title="${escapeHtml(directory.path)}">
        <code>${escapeHtml(folderLabel(record, directory.path))}</code><small>${categoryLabels[directory.category]}</small><span>${formatBytes(directory.allocatedBytes)}</span>
        ${record.generatedDirectories.length > 1 ? `<i class="folder-bar" style="width:${Math.max(1, directory.allocatedBytes / largestFolder * 100)}%"></i>` : ''}
      </li>`).join('') || '<li class="empty-folder">No generated folders found.</li>';

  elements.inspector.innerHTML = `
    <div class="inspector-content">
      <header class="inspector-header">
        <span class="state ${record.activity.state}">${stateLabels[record.activity.state]}</span>
        <h2 id="inspector-title">${escapeHtml(record.branch)}</h2>
        <p>${escapeHtml(locationLine(record))}</p>
      </header>
      <p class="inspector-number">${value}<small>${unit}</small></p>
      <p class="verdict">${verdict(record)}</p>
      <section class="folder-section">
        <h3>Moves to Trash</h3>
        <ul class="folder-list">${folders}</ul>
      </section>
      <section class="details-section">
        <h3>Details</h3>
        <dl class="details">
          <div><dt>Last commit</dt><dd>${record.lastCommitAt === null ? 'Unavailable' : `${age(record.lastCommitAt)} <span>· ${dateTime(record.lastCommitAt)}</span>`}</dd></div>
          <div><dt>Working tree</dt><dd><span class="git-status ${record.status}">${record.status === 'dirty' ? 'Uncommitted changes' : record.status === 'clean' ? 'Clean' : 'Unknown'}</span></dd></div>
          <div><dt>Logical size</dt><dd>${formatBytes(record.generatedBytes)}</dd></div>
          <div><dt>Path</dt><dd><code>${escapeHtml(record.path)}</code></dd></div>
        </dl>
      </section>
    </div>
    <footer class="inspector-action">
      <button id="move-to-trash" class="primary" type="button" ${record.generatedDirectories.length ? '' : 'disabled'}>
        ${record.generatedDirectories.length ? `Move ${formatBytes(record.generatedAllocatedBytes)} to Trash` : 'Nothing to move'}
      </button>
      <p>Source, branches and history stay put. Restore anytime from Trash.</p>
    </footer>`;
  $('#move-to-trash')?.addEventListener('click', openConfirmation);
}

// Rows are built once per report and reused, so search, filters and sorting only reorder nodes.
let rows = new Map();
const recordsByRow = new WeakMap();

function buildRow(record, largest) {
  const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
  const [identity, evidence, ageCell, storage] = row.children;
  row.classList.add(record.activity.state);
  row.title = record.path;
  row.setAttribute('aria-selected', String(record.path === selectedPath));
  identity.firstElementChild.textContent = record.branch;
  identity.lastElementChild.textContent = locationLine(record);
  const state = document.createElement('span');
  state.className = `state ${record.activity.state}`;
  state.textContent = stateLabels[record.activity.state];
  evidence.append(state);
  ageCell.textContent = age(record.lastCommitAt);
  // Bars share one scale across the whole report so filtering never rescales them.
  storage.firstElementChild.firstElementChild.style.setProperty('--fraction', String(Math.max(0.005, record.generatedAllocatedBytes / largest)));
  storage.lastElementChild.textContent = formatBytes(record.generatedAllocatedBytes);
  recordsByRow.set(row, record);
  return row;
}

function buildRows() {
  const largest = Math.max(1, ...report.worktrees.map((record) => record.generatedAllocatedBytes));
  rows = new Map(report.worktrees.map((record) => [record.path, buildRow(record, largest)]));
}

function selectRecord(record) {
  rows.get(selectedPath)?.setAttribute('aria-selected', 'false');
  selectedPath = record.path;
  rows.get(selectedPath)?.setAttribute('aria-selected', 'true');
  renderInspector(record);
}

function renderList() {
  const records = visibleRecords();
  elements.list.replaceChildren(...records.map((record) => rows.get(record.path)));
  elements.empty.hidden = records.length !== 0;
  elements.count.textContent = plural(records.length, 'worktree');
  if (elements.list.classList.contains('is-intro')) stepRowBars();
}

// First paint only: bars on the first screen of rows grow in, one cell (8px) per step.
function stepRowBars() {
  const track = $('.size-bar', elements.list)?.clientWidth ?? 0;
  for (const [index, bar] of [...elements.list.querySelectorAll('.size-bar i')].slice(0, 14).entries()) {
    bar.style.setProperty('--cells', String(Math.max(1, Math.ceil(Number(bar.style.getPropertyValue('--fraction')) * track / 8))));
    bar.style.setProperty('--i', String(index));
  }
}

function renderRoots() {
  $('span', elements.roots).textContent = report.roots.length === 1 ? report.roots[0] : `${report.roots.length} locations`;
  elements.roots.title = report.roots.join('\n');
}

function render(nextReport) {
  const firstPaint = introPending && !reducedMotion.matches;
  report = nextReport;
  ambiguousPaths = findAmbiguousPaths(report.worktrees);
  selectedPath = report.worktrees.some((record) => record.path === selectedPath) ? selectedPath : visibleRecords()[0]?.path;
  elements.loading.hidden = true;
  renderRoots();
  renderHero();

  elements.warningList.replaceChildren();
  for (const warning of report.warnings) {
    const item = document.createElement('li');
    item.textContent = `${warning.path}: ${warning.message}`;
    elements.warningList.append(item);
  }
  elements.warnings.hidden = report.warnings.length === 0;
  if (report.warnings.length) showNotice(`${plural(report.warnings.length, 'scan note')} — results may be partial.`, 'warning');
  else if (elements.notice.classList.contains('warning')) showNotice('');

  buildRows();
  if (firstPaint) {
    elements.list.classList.add('is-intro');
    setTimeout(() => elements.list.classList.remove('is-intro'), 1800);
  }
  renderList();
  renderInspector(selected());
}

async function scan() {
  elements.refresh.disabled = true;
  elements.refresh.classList.add('is-loading');
  elements.status.textContent = report ? 'Rescanning…' : 'Scanning…';
  elements.error.hidden = true;
  try {
    const response = await fetch('/api/report');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message);
    mutationToken = payload.mutationToken;
    render(payload.report);
    elements.status.textContent = `Scanned ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(payload.report.scannedAt)}`;
  } catch (error) {
    elements.error.textContent = error instanceof Error ? error.message : 'The scan failed.';
    elements.error.hidden = false;
    elements.status.textContent = 'Scan failed';
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.classList.remove('is-loading');
  }
}

function openConfirmation() {
  const record = selected();
  if (!record) return;
  elements.confirmDescription.textContent = `From ${record.branch}. They go to ~/.Trash/Worktree Diet, so you can put them back if you need to.`;
  elements.confirmList.replaceChildren();
  for (const directory of record.generatedDirectories) {
    const item = document.createElement('li');
    item.innerHTML = `<code>${escapeHtml(folderLabel(record, directory.path))}</code><span>${formatBytes(directory.allocatedBytes)}</span>`;
    elements.confirmList.append(item);
  }
  elements.confirmMove.textContent = `Move ${formatBytes(record.generatedAllocatedBytes)} to Trash`;
  elements.dialog.returnValue = '';
  elements.dialog.showModal();
}

elements.dialog.addEventListener('close', async () => {
  if (elements.dialog.returnValue !== 'confirm') return;
  const record = selected();
  if (!record || !mutationToken) return;
  elements.confirmMove.disabled = true;
  try {
    const response = await fetch('/api/move-to-trash', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worktree-diet-token': mutationToken },
      body: JSON.stringify({ worktreePath: record.path }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message);
    mutationToken = payload.mutationToken;
    render(payload.report);
    // Report what the server actually moved — scanned sizes describe intent, not outcome.
    const { moved, warnings } = payload.result;
    const skipped = warnings.length ? ` Skipped ${warnings.map((warning) => `${folderLabel(record, warning.path)} (${warning.message})`).join(', ')}.` : '';
    if (moved.length === 0) showNotice(`Nothing moved from ${record.branch}.${skipped}`, 'warning');
    else showNotice(`Moved ${plural(moved.length, 'folder')} from ${record.branch} to Trash.${skipped}`, warnings.length ? 'warning' : 'success');
  } catch (error) {
    elements.error.textContent = error instanceof Error ? error.message : 'Unable to move folders to Trash.';
    elements.error.hidden = false;
  } finally {
    elements.confirmMove.disabled = false;
  }
});

elements.refresh.addEventListener('click', scan);
let searchFrame = 0;
elements.search.addEventListener('input', () => {
  cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(renderList);
});
elements.sort.addEventListener('click', () => {
  descending = !descending;
  elements.sort.classList.toggle('ascending', !descending);
  elements.sort.setAttribute('aria-label', `Sort by generated storage, ${descending ? 'largest' : 'smallest'} first`);
  renderList();
});
elements.list.addEventListener('click', (event) => {
  const row = event.target.closest('.worktree-row');
  if (row) selectRecord(recordsByRow.get(row));
});
elements.list.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...elements.list.querySelectorAll('.worktree-row')];
  const current = rows.indexOf(document.activeElement);
  const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
  if (rows[next]) {
    event.preventDefault();
    rows[next].focus();
    rows[next].click();
  }
});
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
  renderList();
}));

scan();
