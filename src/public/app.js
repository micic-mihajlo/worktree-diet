const $ = (selector, root = document) => root.querySelector(selector);
const elements = { roots: $('#roots'), refresh: $('#refresh'), status: $('#scan-status'), reclaimable: $('#reclaimable'), inactive: $('#inactive-count'), review: $('#review-count'), scanTime: $('#scan-time'), notice: $('#notice'), error: $('#error'), loading: $('#loading'), list: $('#worktree-list'), empty: $('#empty'), count: $('#result-count'), inspector: $('#inspector'), warnings: $('#warnings'), warningList: $('#warning-list'), search: $('#search'), sort: $('#sort'), dialog: $('#confirm-dialog'), confirmDescription: $('#confirm-description'), confirmList: $('#confirm-list'), confirmMove: $('#confirm-move'), rowTemplate: $('#row-template') };
const categoryLabels = { dependencies: 'Dependencies', buildOutput: 'Build output', caches: 'Caches', sourceOther: 'Source / other' };
let report; let mutationToken; let selectedPath; let activeFilter = 'all'; let descending = true;
const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const age = (time) => time === null ? 'Unknown' : `${Math.floor(Math.max(0, Date.now() - time) / 86_400_000)}d`;
const repositoryName = (path) => path.split('/').filter(Boolean).at(-1) ?? path;
function selected() { return report?.worktrees.find((record) => record.path === selectedPath); }
function showNotice(message, kind = '') { elements.notice.textContent = message; elements.notice.className = `notice ${kind}`; elements.notice.hidden = !message; }
function visibleRecords() {
  const query = elements.search.value.trim().toLowerCase();
  return (report?.worktrees ?? []).filter((record) => (activeFilter === 'all' || record.activity.state === activeFilter) && (!query || `${record.branch} ${record.repositoryPath} ${record.path}`.toLowerCase().includes(query))).sort((a, b) => (descending ? -1 : 1) * (a.generatedAllocatedBytes - b.generatedAllocatedBytes));
}
function renderInspector(record) {
  if (!record) { elements.inspector.innerHTML = '<p class="empty-state">Select a worktree to inspect its evidence.</p>'; return; }
  const generated = record.generatedDirectories.map((directory) => `<li><code>${escapeHtml(directory.path)}</code><span>${formatBytes(directory.allocatedBytes)} allocated</span></li>`).join('') || '<li>No generated folders found.</li>';
  const breakdown = Object.entries(categoryLabels).map(([category, label]) => `<tr><th>${label}</th><td>${formatBytes(record.sizes[category])} logical</td><td>${formatBytes(record.allocatedSizes[category])} allocated</td></tr>`).join('');
  elements.inspector.innerHTML = `<div class="inspector-content"><header><p class="eyebrow">Selected worktree</p><h2 id="inspector-title">${escapeHtml(record.branch)}</h2><code>${escapeHtml(record.path)}</code></header><section><h3>Evidence: <span class="state ${record.activity.state}">${record.activity.state.replace('-', ' ')}</span></h3><ul>${record.activity.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></section><section><h3>Measured storage</h3><p><strong>${formatBytes(record.generatedAllocatedBytes)}</strong> allocated generated · ${formatBytes(record.generatedBytes)} logical generated</p><table><thead><tr><th>Category</th><th>Logical</th><th>Allocated</th></tr></thead><tbody>${breakdown}</tbody></table></section><section><h3>Generated folders</h3><ul class="folder-list">${generated}</ul></section><button id="move-to-trash" class="primary move" type="button" ${record.generatedDirectories.length ? '' : 'disabled'}>Move generated folders to Trash</button></div>`;
  $('#move-to-trash')?.addEventListener('click', openConfirmation);
}
function escapeHtml(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function renderList() {
  const records = visibleRecords(); elements.list.replaceChildren(); elements.empty.hidden = records.length !== 0; elements.count.textContent = `${records.length} shown`;
  for (const record of records) {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true); row.setAttribute('aria-selected', String(record.path === selectedPath));
    $('.branch', row).textContent = record.branch; $('.repo', row).textContent = repositoryName(record.repositoryPath); $('.path', row).textContent = record.path; $('.evidence', row).innerHTML = `<span class="state ${record.activity.state}">${record.activity.state.replace('-', ' ')}</span>`; $('.age', row).textContent = age(record.lastCommitAt); $('.status', row).textContent = record.status; $('.status', row).dataset.status = record.status; $('.allocated', row).textContent = formatBytes(record.generatedAllocatedBytes);
    row.addEventListener('click', () => { selectedPath = record.path; renderList(); renderInspector(record); }); elements.list.append(row);
  }
}
function render(nextReport) {
  report = nextReport; selectedPath = report.worktrees.some((record) => record.path === selectedPath) ? selectedPath : report.worktrees[0]?.path;
  const inactive = report.worktrees.filter((record) => record.activity.state === 'likely-inactive').length; const review = report.worktrees.filter((record) => record.activity.state === 'review').length;
  elements.roots.textContent = report.roots.join(' · '); elements.reclaimable.textContent = formatBytes(report.generatedAllocatedBytes); elements.inactive.textContent = String(inactive); elements.review.textContent = String(review); elements.scanTime.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(report.scannedAt); elements.loading.hidden = true;
  elements.warningList.replaceChildren(); for (const warning of report.warnings) { const item = document.createElement('li'); item.textContent = `${warning.path}: ${warning.message}`; elements.warningList.append(item); } elements.warnings.hidden = report.warnings.length === 0; if (report.warnings.length) showNotice(`${report.warnings.length} scan note${report.warnings.length === 1 ? '' : 's'}: results may be partial.`, 'warning');
  renderList(); renderInspector(selected());
}
async function scan() {
  elements.refresh.disabled = true; elements.status.textContent = report ? 'Refreshing scan…' : 'Scanning worktrees…'; elements.error.hidden = true;
  try { const response = await fetch('/api/report'); const payload = await response.json(); if (!response.ok) throw new Error(payload.message); mutationToken = payload.mutationToken; render(payload.report); elements.status.textContent = `Scanned ${payload.report.worktrees.length} worktree${payload.report.worktrees.length === 1 ? '' : 's'}`; }
  catch (error) { elements.error.textContent = error instanceof Error ? error.message : 'The scan failed.'; elements.error.hidden = false; elements.status.textContent = 'Scan failed'; }
  finally { elements.refresh.disabled = false; }
}
function openConfirmation() { const record = selected(); if (!record) return; elements.confirmDescription.textContent = `The following generated folders will be moved to ~/.Trash/Worktree Diet. Source files, Git metadata, and the worktree stay in place.`; elements.confirmList.replaceChildren(); for (const directory of record.generatedDirectories) { const item = document.createElement('li'); item.textContent = directory.path; elements.confirmList.append(item); } elements.confirmMove.textContent = `Move ${formatBytes(record.generatedAllocatedBytes)} to Trash`; elements.dialog.showModal(); }
elements.dialog.addEventListener('close', async () => { if (elements.dialog.returnValue !== 'confirm') return; const record = selected(); if (!record || !mutationToken) return; elements.confirmMove.disabled = true; try { const response = await fetch('/api/move-to-trash', { method: 'POST', headers: { 'content-type': 'application/json', 'x-worktree-diet-token': mutationToken }, body: JSON.stringify({ worktreePath: record.path }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message); mutationToken = payload.mutationToken; render(payload.report); const skipped = payload.result.warnings.length ? ` ${payload.result.warnings.length} folder(s) were skipped.` : ''; showNotice(`Moved ${payload.result.moved.length} generated folder(s) to Trash.${skipped}`, 'success'); } catch (error) { elements.error.textContent = error instanceof Error ? error.message : 'Unable to move folders to Trash.'; elements.error.hidden = false; } finally { elements.confirmMove.disabled = false; } });
elements.refresh.addEventListener('click', scan); elements.search.addEventListener('input', renderList); elements.sort.addEventListener('click', () => { descending = !descending; elements.sort.textContent = `Allocated generated ${descending ? '↓' : '↑'}`; renderList(); });
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { activeFilter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button))); renderList(); }));
scan();
