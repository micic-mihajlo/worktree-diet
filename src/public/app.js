const $ = (selector, root = document) => root.querySelector(selector);

const elements = {
  roots: $('#roots'),
  refresh: $('#refresh'),
  status: $('#scan-status'),
  readyValue: $('#ready-value'),
  readyUnit: $('#ready-unit'),
  heroDetail: $('#hero-detail'),
  statusBar: $('#status-bar'),
  allSize: $('#all-size'),
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
  const [value, unit] = byteParts(ready.bytes);
  elements.readyValue.textContent = value;
  elements.readyUnit.textContent = unit;
  elements.heroDetail.innerHTML = ready.count
    ? `sitting in <strong>${plural(ready.count, 'worktree')}</strong> that look abandoned, out of ${formatBytes(report.generatedAllocatedBytes)} of generated files across ${plural(report.worktrees.length, 'worktree')}.`
    : `Nothing looks abandoned yet — ${formatBytes(report.generatedAllocatedBytes)} generated across ${plural(report.worktrees.length, 'worktree')}.`;

  const whole = Math.max(1, report.generatedAllocatedBytes);
  elements.statusBar.innerHTML = states
    .filter((state) => totals[state].bytes > 0)
    .map((state) => `<i class="${state}" style="flex-grow:${totals[state].bytes / whole}" title="${stateLabels[state]}: ${formatBytes(totals[state].bytes)}"></i>`)
    .join('');
  elements.statusBar.setAttribute('aria-label', states.map((state) => `${stateLabels[state]} ${formatBytes(totals[state].bytes)}`).join(', '));

  elements.allSize.textContent = formatBytes(report.generatedAllocatedBytes);
  for (const state of states) $(`#${state}-size`).textContent = formatBytes(totals[state].bytes);
}

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
        Move ${formatBytes(record.generatedAllocatedBytes)} to Trash
      </button>
      <p>Source, branches and history stay put. Restore anytime from Trash.</p>
    </footer>`;
  $('#move-to-trash')?.addEventListener('click', openConfirmation);
}

function selectRecord(record, row) {
  selectedPath = record.path;
  elements.list.querySelectorAll('.worktree-row').forEach((candidate) => candidate.setAttribute('aria-selected', String(candidate === row)));
  renderInspector(record);
}

function renderList() {
  const records = visibleRecords();
  elements.list.replaceChildren();
  elements.empty.hidden = records.length !== 0;
  elements.count.textContent = plural(records.length, 'worktree');

  // Bars share one scale across the whole report so filtering never rescales them.
  const largest = Math.max(1, ...report.worktrees.map((record) => record.generatedAllocatedBytes));
  for (const record of records) {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    row.setAttribute('aria-selected', String(record.path === selectedPath));
    row.classList.add(record.activity.state);
    $('.branch', row).textContent = record.branch;
    $('.location-line', row).textContent = locationLine(record);
    row.title = record.path;
    $('.evidence', row).innerHTML = `<span class="state ${record.activity.state}">${stateLabels[record.activity.state]}</span>`;
    $('.age', row).textContent = age(record.lastCommitAt);
    $('.allocated', row).textContent = formatBytes(record.generatedAllocatedBytes);
    $('.size-bar i', row).style.width = `${Math.max(1, record.generatedAllocatedBytes / largest * 100)}%`;
    row.addEventListener('click', () => selectRecord(record, row));
    elements.list.append(row);
  }
}

function renderRoots() {
  $('span', elements.roots).textContent = report.roots.length === 1 ? report.roots[0] : `${report.roots.length} locations`;
  elements.roots.title = report.roots.join('\n');
}

function render(nextReport) {
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
elements.search.addEventListener('input', renderList);
elements.sort.addEventListener('click', () => {
  descending = !descending;
  elements.sort.classList.toggle('ascending', !descending);
  elements.sort.setAttribute('aria-label', `Sort by generated storage, ${descending ? 'largest' : 'smallest'} first`);
  renderList();
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
