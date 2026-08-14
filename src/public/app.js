const $ = (selector, root = document) => root.querySelector(selector);

const elements = {
  roots: $('#roots'),
  refresh: $('#refresh'),
  status: $('#scan-status'),
  reclaimable: $('#reclaimable'),
  all: $('#all-count'),
  inactive: $('#inactive-count'),
  review: $('#review-count'),
  recent: $('#recent-count'),
  scanTime: $('#scan-time'),
  notice: $('#notice'),
  error: $('#error'),
  loading: $('#loading'),
  list: $('#worktree-list'),
  empty: $('#empty'),
  count: $('#result-count'),
  collectionSummary: $('#collection-summary'),
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

const categoryLabels = {
  dependencies: 'Dependencies',
  buildOutput: 'Build output',
  caches: 'Caches',
};

let report;
let mutationToken;
let selectedPath;
let activeFilter = 'all';
let descending = true;

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const age = (time) => {
  if (time === null) return 'Unknown';
  const days = Math.floor(Math.max(0, Date.now() - time) / 86_400_000);
  if (days === 0) return 'Today';
  return `${days}d ago`;
};

const dateTime = (time) => time === null ? 'Unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time);

const repositoryName = (path) => path.split('/').filter(Boolean).at(-1) ?? path;
const stateLabel = (state) => state === 'likely-inactive' ? 'Likely inactive' : state === 'review' ? 'Review' : 'Recent';
const selected = () => report?.worktrees.find((record) => record.path === selectedPath);

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

function visibleRecords() {
  const query = elements.search.value.trim().toLowerCase();
  return (report?.worktrees ?? [])
    .filter((record) => activeFilter === 'all' || record.activity.state === activeFilter)
    .filter((record) => !query || `${record.branch} ${record.repositoryPath} ${record.path}`.toLowerCase().includes(query))
    .sort((left, right) => (descending ? -1 : 1) * (left.generatedAllocatedBytes - right.generatedAllocatedBytes));
}

function renderInspector(record) {
  if (!record) {
    elements.inspector.innerHTML = '<div class="inspector-empty"><span class="empty-icon" aria-hidden="true"></span><p>Select a worktree to inspect its storage.</p></div>';
    return;
  }

  const generatedTotal = Math.max(1, record.generatedAllocatedBytes);
  const breakdown = Object.entries(categoryLabels).map(([category, label]) => {
    const allocated = record.allocatedSizes[category];
    const width = Math.max(allocated ? 2 : 0, allocated / generatedTotal * 100);
    return `<li><div><span>${label}</span><strong>${formatBytes(allocated)}</strong></div><i><b style="width:${width}%"></b></i></li>`;
  }).join('');
  const generated = record.generatedDirectories.map((directory) => `
    <li><div><code>${escapeHtml(directory.name)}</code><span>${formatBytes(directory.allocatedBytes)}</span></div><small>${escapeHtml(directory.path)}</small></li>
  `).join('') || '<li class="empty-folder">No generated folders found.</li>';
  const reasons = record.activity.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');

  elements.inspector.innerHTML = `
    <div class="inspector-content">
      <header class="inspector-header">
        <span class="inspector-glyph" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M5.5 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM14.5 11.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5.5 8.5v2.3a2.7 2.7 0 0 0 2.7 2.7h4.3M14.5 11.5V5.2M12.5 7.2l2-2 2 2"></path></svg></span>
        <div><h2 id="inspector-title">${escapeHtml(record.branch)}</h2><p>${escapeHtml(repositoryName(record.repositoryPath))}</p></div>
      </header>
      <section class="inspector-metric">
        <strong>${formatBytes(record.generatedAllocatedBytes)}</strong>
        <span>generated storage · ${formatBytes(record.generatedBytes)} logical</span>
      </section>
      <dl class="metadata-list">
        <div><dt>Location</dt><dd><code>${escapeHtml(record.path)}</code></dd></div>
        <div><dt>Last commit</dt><dd>${escapeHtml(dateTime(record.lastCommitAt))}</dd></div>
        <div><dt>Working tree</dt><dd><span class="git-status ${record.status}">${escapeHtml(record.status)}</span></dd></div>
        <div><dt>Recommendation</dt><dd><span class="state ${record.activity.state}">${stateLabel(record.activity.state)}</span></dd></div>
      </dl>
      <section class="evidence-card"><h3>Why this recommendation</h3><ul>${reasons}</ul></section>
      <section class="breakdown-section">
        <h3>Storage breakdown</h3>
        <ul class="breakdown">${breakdown}</ul>
      </section>
      <section class="folder-section">
        <h3>Generated folders <span>${record.generatedDirectories.length}</span></h3>
        <ul class="folder-list">${generated}</ul>
      </section>
    </div>
    <footer class="inspector-action">
      <p>Source files, branch history, and the worktree stay in place.</p>
      <button id="move-to-trash" class="primary" type="button" ${record.generatedDirectories.length ? '' : 'disabled'}>
        Move ${formatBytes(record.generatedAllocatedBytes)} to Trash
      </button>
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
  elements.count.textContent = `${records.length} shown`;
  elements.collectionSummary.textContent = `${records.length} ${records.length === 1 ? 'worktree' : 'worktrees'} · ${formatBytes(records.reduce((sum, record) => sum + record.generatedAllocatedBytes, 0))}`;

  for (const record of records) {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    row.setAttribute('aria-selected', String(record.path === selectedPath));
    $('.branch', row).textContent = record.branch;
    $('.repo', row).textContent = repositoryName(record.repositoryPath);
    $('.path', row).textContent = record.path;
    $('.evidence', row).innerHTML = `<span class="state ${record.activity.state}">${stateLabel(record.activity.state)}</span>`;
    $('.age', row).textContent = age(record.lastCommitAt);
    $('.allocated', row).textContent = formatBytes(record.generatedAllocatedBytes);
    row.addEventListener('click', () => selectRecord(record, row));
    elements.list.append(row);
  }
}

function render(nextReport) {
  report = nextReport;
  selectedPath = report.worktrees.some((record) => record.path === selectedPath) ? selectedPath : report.worktrees[0]?.path;
  const counts = report.worktrees.reduce((total, record) => {
    total[record.activity.state] += 1;
    return total;
  }, { 'likely-inactive': 0, review: 0, recent: 0 });

  elements.roots.textContent = report.roots.join('\n');
  elements.reclaimable.textContent = formatBytes(report.generatedAllocatedBytes);
  elements.all.textContent = String(report.worktrees.length);
  elements.inactive.textContent = String(counts['likely-inactive']);
  elements.review.textContent = String(counts.review);
  elements.recent.textContent = String(counts.recent);
  elements.scanTime.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(report.scannedAt);
  elements.loading.hidden = true;

  elements.warningList.replaceChildren();
  for (const warning of report.warnings) {
    const item = document.createElement('li');
    item.textContent = `${warning.path}: ${warning.message}`;
    elements.warningList.append(item);
  }
  elements.warnings.hidden = report.warnings.length === 0;
  if (report.warnings.length) showNotice(`${report.warnings.length} scan note${report.warnings.length === 1 ? '' : 's'} — results may be partial.`, 'warning');
  else if (elements.notice.classList.contains('warning')) showNotice('');

  renderList();
  renderInspector(selected());
}

async function scan() {
  elements.refresh.disabled = true;
  elements.refresh.classList.add('is-loading');
  elements.status.textContent = report ? 'Refreshing…' : 'Scanning…';
  elements.error.hidden = true;
  try {
    const response = await fetch('/api/report');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message);
    mutationToken = payload.mutationToken;
    render(payload.report);
    elements.status.textContent = `${payload.report.worktrees.length} worktree${payload.report.worktrees.length === 1 ? '' : 's'} scanned`;
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
  elements.confirmDescription.textContent = 'These generated folders will move to ~/.Trash/Worktree Diet. You can restore them from Trash if needed.';
  elements.confirmList.replaceChildren();
  for (const directory of record.generatedDirectories) {
    const item = document.createElement('li');
    item.innerHTML = `<code>${escapeHtml(directory.name)}</code><span>${formatBytes(directory.allocatedBytes)}</span>`;
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
    const skipped = payload.result.warnings.length ? ` ${payload.result.warnings.length} folder(s) were skipped.` : '';
    showNotice(`Moved ${payload.result.moved.length} generated folder(s) to Trash.${skipped}`, 'success');
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
  $('span', elements.sort).textContent = descending ? 'Largest first' : 'Smallest first';
  elements.sort.setAttribute('aria-label', `Sort by generated disk space ${descending ? 'descending' : 'ascending'}`);
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
