import type { WorktreeRecord } from "../scanner.ts";
import { age, byteParts, escapeHtml, formatBytes, formatDate } from "./format.ts";
import { categoryLabels, folderLabel, locationLine, stateLabels, verdict } from "./model.ts";

const statusLabels: Record<WorktreeRecord["status"], string> = {
  clean: "Clean",
  dirty: "Uncommitted changes",
  unknown: "Unknown",
};

/** The selected worktree: what it is, how much it would give back, and exactly what moves. */
export function renderInspector(
  container: HTMLElement,
  record: WorktreeRecord | undefined,
  ambiguous: ReadonlySet<string>,
  onMove: () => void,
): void {
  if (!record) {
    container.innerHTML = '<p class="inspector-empty">Select a worktree to see what would move to Trash.</p>';
    return;
  }

  const [value, unit] = byteParts(record.generatedAllocatedBytes);
  const directories = record.generatedDirectories.toSorted((left, right) => right.allocatedBytes - left.allocatedBytes);
  const largest = Math.max(1, ...directories.map((directory) => directory.allocatedBytes));
  const folders =
    directories
      .map((directory) => {
        const bar =
          directories.length > 1
            ? `<i class="folder-bar" style="width:${Math.max(1, (directory.allocatedBytes / largest) * 100)}%"></i>`
            : "";
        return `
      <li title="${escapeHtml(directory.path)}">
        <code>${escapeHtml(folderLabel(record, directory.path))}</code><small>${categoryLabels[directory.category]}</small><span>${formatBytes(directory.allocatedBytes)}</span>
        ${bar}
      </li>`;
      })
      .join("") || '<li class="empty-folder">No generated folders found.</li>';
  const lastCommit =
    record.lastCommitAt === null
      ? "Unavailable"
      : `${age(record.lastCommitAt)} <span>· ${formatDate(record.lastCommitAt)}</span>`;
  const canMove = directories.length > 0;

  container.innerHTML = `
    <div class="inspector-content">
      <header class="inspector-header">
        <span class="state ${record.activity.state}">${stateLabels[record.activity.state]}</span>
        <h2 id="inspector-title">${escapeHtml(record.branch)}</h2>
        <p>${escapeHtml(locationLine(record, ambiguous))}</p>
      </header>
      <p class="inspector-number">${value}<small>${unit}</small></p>
      <p class="verdict">${escapeHtml(verdict(record))}</p>
      <section class="folder-section">
        <h3>Moves to Trash</h3>
        <ul class="folder-list">${folders}</ul>
      </section>
      <section class="details-section">
        <h3>Details</h3>
        <dl class="details">
          <div><dt>Last commit</dt><dd>${lastCommit}</dd></div>
          <div><dt>Working tree</dt><dd><span class="git-status ${record.status}">${statusLabels[record.status]}</span></dd></div>
          <div><dt>Logical size</dt><dd>${formatBytes(record.generatedBytes)}</dd></div>
          <div><dt>Path</dt><dd><code>${escapeHtml(record.path)}</code></dd></div>
        </dl>
      </section>
    </div>
    <footer class="inspector-action">
      <button id="move-to-trash" class="primary" type="button" ${canMove ? "" : "disabled"}>
        ${canMove ? `Move ${formatBytes(record.generatedAllocatedBytes)} to Trash` : "Nothing to move"}
      </button>
      <p>Source, branches and history stay put. Restore anytime from Trash.</p>
    </footer>`;
  container.querySelector("#move-to-trash")?.addEventListener("click", onMove);
}
