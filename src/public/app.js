const total = document.querySelector('#total');
const generated = document.querySelector('#generated');
const repository = document.querySelector('#repository');
const status = document.querySelector('#scan-status');
const worktrees = document.querySelector('#worktrees');
const error = document.querySelector('#error');
const errorMessage = document.querySelector('#error-message');
const warnings = document.querySelector('#warnings');
const warningList = document.querySelector('#warning-list');
const empty = document.querySelector('#empty');
const refresh = document.querySelector('#refresh');
const template = document.querySelector('#worktree-template');
let hasReport = false;

const labels = { dependencies: 'Dependencies', buildOutput: 'Build output', caches: 'Caches', sourceOther: 'Source / other' };
const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const commitAge = (time) => {
  if (!time) return 'Commit time unavailable';
  const hours = Math.max(0, Math.round((Date.now() - time) / 3_600_000));
  return hours < 24 ? `${hours}h since commit` : `${Math.round(hours / 24)}d since commit`;
};

function text(element, value) { element.textContent = value; }
function createBar(category, bytes, totalBytes) {
  const item = document.createElement('div'); item.className = 'bar-row';
  const label = document.createElement('span'); text(label, labels[category]);
  const line = document.createElement('div'); line.className = `bar ${category}`;
  const fill = document.createElement('i'); fill.style.width = `${totalBytes ? Math.max(1, bytes / totalBytes * 100) : 0}%`; line.append(fill);
  const size = document.createElement('b'); text(size, formatBytes(bytes));
  item.append(label, line, size); return item;
}
async function copyCleanup(button, path) {
  const response = await fetch(`/api/cleanup-command?path=${encodeURIComponent(path)}`);
  if (!response.ok) return;
  const { command } = await response.json();
  await navigator.clipboard.writeText(command);
  const original = button.textContent; text(button, 'Copied');
  window.setTimeout(() => text(button, original), 1400);
}
function render(report) {
  hasReport = true; error.hidden = true; empty.hidden = report.worktrees.length !== 0;
  text(total, formatBytes(report.totalBytes)); text(generated, formatBytes(report.generatedBytes)); text(repository, report.repositoryPath);
  worktrees.replaceChildren();
  for (const record of report.worktrees) {
    const node = template.content.firstElementChild.cloneNode(true);
    text(node.querySelector('.branch'), record.branch); text(node.querySelector('.path'), record.path);
    const state = node.querySelector('.state'); text(state, record.status); state.dataset.state = record.status;
    text(node.querySelector('.age'), commitAge(record.lastCommitAt)); text(node.querySelector('.worktree-total strong'), formatBytes(record.totalBytes));
    const bars = node.querySelector('.bars');
    for (const category of Object.keys(labels)) bars.append(createBar(category, record.sizes[category], record.totalBytes));
    const cleanup = node.querySelector('.cleanup');
    if (record.generatedDirectories.length) {
      const intro = document.createElement('p'); text(intro, 'Generated folders found. Verify this branch is inactive before cleanup.'); cleanup.append(intro);
      for (const directory of record.generatedDirectories.slice(0, 3)) {
        const row = document.createElement('div'); row.className = 'cleanup-row';
        const name = document.createElement('span'); text(name, directory.name);
        const copy = document.createElement('button'); copy.type = 'button'; text(copy, 'Copy cleanup command'); copy.addEventListener('click', () => copyCleanup(copy, directory.path));
        row.append(name, copy); cleanup.append(row);
      }
    }
    worktrees.append(node);
  }
  warningList.replaceChildren();
  warnings.hidden = report.warnings.length === 0;
  for (const warning of report.warnings) { const item = document.createElement('li'); text(item, `${warning.path}: ${warning.message}`); warningList.append(item); }
}
async function scan({ announce = true } = {}) {
  refresh.disabled = true; status.dataset.state = 'scanning'; text(status, hasReport ? 'Refreshing — previous report remains visible' : 'Scanning worktrees…');
  try {
    const response = await fetch('/api/report'); const payload = await response.json();
    if (!response.ok) throw new Error(payload.message);
    render(payload.report); status.dataset.state = 'complete'; text(status, `Scanned ${payload.report.worktrees.length} worktree${payload.report.worktrees.length === 1 ? '' : 's'}`);
  } catch (cause) {
    error.hidden = false; text(errorMessage, cause instanceof Error ? cause.message : 'The scan failed.'); status.dataset.state = 'error'; text(status, 'Scan failed');
  } finally { refresh.disabled = false; if (!announce) status.removeAttribute('aria-live'); }
}
refresh.addEventListener('click', () => scan());
scan({ announce: false });
