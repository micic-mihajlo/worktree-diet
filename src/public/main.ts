import type { ScanReport, WorktreeRecord } from "../scanner.ts";
import { fetchReport, moveToTrash } from "./api.ts";
import { element } from "./dom.ts";
import { escapeHtml, formatBytes, formatTime, plural } from "./format.ts";
import { renderInspector } from "./inspector.ts";
import { WorktreeList } from "./list.ts";
import { StorageMeter } from "./meter.ts";
import { type Filter, filterRecords, findAmbiguousPaths, folderLabel, states, stateTotals } from "./model.ts";

const ui = {
  roots: element("#roots"),
  refresh: element<HTMLButtonElement>("#refresh"),
  status: element("#scan-status"),
  heroDetail: element("#hero-detail"),
  allCount: element("#all-count"),
  stateCounts: Object.fromEntries(states.map((state) => [state, element(`#${state}-count`)])),
  filters: [...document.querySelectorAll<HTMLButtonElement>("[data-filter]")],
  search: element<HTMLInputElement>("#search"),
  sort: element<HTMLButtonElement>("#sort"),
  notice: element("#notice"),
  error: element("#error"),
  loading: element("#loading"),
  empty: element("#empty"),
  count: element("#result-count"),
  inspector: element("#inspector"),
  warnings: element("#warnings"),
  warningList: element("#warning-list"),
  dialog: element<HTMLDialogElement>("#confirm-dialog"),
  confirmDescription: element("#confirm-description"),
  confirmList: element("#confirm-list"),
  confirmMove: element<HTMLButtonElement>("#confirm-move"),
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const meter = new StorageMeter({
  hero: element(".hero"),
  meter: element("#meter"),
  labels: element("#meter-labels"),
  readyValue: element("#ready-value"),
  readyUnit: element("#ready-unit"),
});
const list = new WorktreeList(element("#worktree-list"), element<HTMLTemplateElement>("#row-template"), select);

const state: {
  report: ScanReport | undefined;
  mutationToken: string | undefined;
  selectedPath: string | undefined;
  filter: Filter;
  descending: boolean;
  ambiguous: ReadonlySet<string>;
  firstPaint: boolean;
  confirming: MoveTarget | undefined;
} = {
  report: undefined,
  mutationToken: undefined,
  selectedPath: undefined,
  filter: "all",
  descending: true,
  ambiguous: new Set(),
  firstPaint: true,
  confirming: undefined,
};

/** What the confirmation dialog listed, so the move acts on exactly that even if a rescan lands first. */
interface MoveTarget {
  path: string;
  branch: string;
  directories: string[];
}

const visibleRecords = (): WorktreeRecord[] =>
  filterRecords(state.report?.worktrees ?? [], {
    filter: state.filter,
    query: ui.search.value,
    descending: state.descending,
  });
const selected = (): WorktreeRecord | undefined =>
  state.report?.worktrees.find((record) => record.path === state.selectedPath);

function showNotice(message: string, kind: "" | "warning" | "success" = ""): void {
  ui.notice.textContent = message;
  ui.notice.className = `notice ${kind}`;
  ui.notice.hidden = !message;
}

function showError(error: unknown, fallback: string): void {
  ui.error.textContent = error instanceof Error ? error.message : fallback;
  ui.error.hidden = false;
}

// Scans and moves run one at a time, in order. A move confirmed during a rescan waits for it rather than
// being dropped, and a scan requested while another is pending joins that one.
let queue: Promise<void> = Promise.resolve();
let queued = 0;
let pendingScan: Promise<void> | undefined;

function enqueue(task: () => Promise<void>): Promise<void> {
  queued += 1;
  ui.refresh.classList.add("is-loading");
  const run = queue.then(task).finally(() => {
    queued -= 1;
    if (queued === 0) ui.refresh.classList.remove("is-loading");
  });
  queue = run.catch(() => undefined);
  return run;
}

function render(report: ScanReport): void {
  const intro = state.firstPaint && !reducedMotion.matches;
  state.firstPaint = false;
  state.report = report;
  state.ambiguous = findAmbiguousPaths(report.worktrees);
  if (!report.worktrees.some((record) => record.path === state.selectedPath))
    state.selectedPath = visibleRecords()[0]?.path;
  ui.loading.hidden = true;

  ui.roots
    .querySelector("span")
    ?.replaceChildren(report.roots.length === 1 ? (report.roots[0] ?? "") : `${report.roots.length} locations`);
  ui.roots.title = report.roots.join("\n");

  const totals = stateTotals(report);
  const ready = totals["likely-inactive"];
  const generated = formatBytes(report.generatedAllocatedBytes);
  const worktrees = plural(report.worktrees.length, "worktree");
  ui.heroDetail.innerHTML = ready.count
    ? `sitting in <strong>${plural(ready.count, "worktree")}</strong> that look abandoned, out of ${generated} of generated files across ${worktrees}.`
    : `Nothing looks abandoned yet — ${generated} generated across ${worktrees}.`;
  ui.allCount.textContent = String(report.worktrees.length);
  for (const activity of states) {
    const counter = ui.stateCounts[activity];
    if (counter) counter.textContent = String(totals[activity].count);
  }
  meter.update(
    { "likely-inactive": ready.bytes, review: totals.review.bytes, recent: totals.recent.bytes },
    report.generatedAllocatedBytes,
    intro,
  );

  ui.warningList.replaceChildren(
    ...report.warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = `${warning.path}: ${warning.message}`;
      return item;
    }),
  );
  ui.warnings.hidden = report.warnings.length === 0;
  if (report.warnings.length)
    showNotice(`${plural(report.warnings.length, "scan note")} — results may be partial.`, "warning");
  else if (ui.notice.classList.contains("warning")) showNotice("");

  list.build(report.worktrees, state.ambiguous, state.selectedPath);
  renderList(intro);
  renderInspector(ui.inspector, selected(), state.ambiguous, openConfirmation);
}

function renderList(intro = false): void {
  const records = visibleRecords();
  list.show(records, intro);
  ui.empty.hidden = records.length !== 0;
  ui.count.textContent = plural(records.length, "worktree");
}

function select(record: WorktreeRecord): void {
  state.selectedPath = record.path;
  list.select(record.path);
  renderInspector(ui.inspector, record, state.ambiguous, openConfirmation);
}

function scan(): Promise<void> {
  pendingScan ??= enqueue(async () => {
    ui.status.textContent = state.report ? "Rescanning…" : "Scanning…";
    ui.error.hidden = true;
    try {
      const { report, mutationToken } = await fetchReport();
      state.mutationToken = mutationToken;
      render(report);
      ui.status.textContent = `Scanned ${formatTime(report.scannedAt)}`;
    } catch (error) {
      showError(error, "The scan failed.");
      ui.status.textContent = "Scan failed";
    }
  }).finally(() => {
    pendingScan = undefined;
  });
  return pendingScan;
}

function openConfirmation(): void {
  const record = selected();
  if (!record) return;
  state.confirming = {
    path: record.path,
    branch: record.branch,
    directories: record.generatedDirectories.map((directory) => directory.path),
  };
  ui.confirmDescription.textContent = `From ${record.branch}. They go to ~/.Trash/Worktree Diet, so you can put them back if you need to.`;
  ui.confirmList.innerHTML = record.generatedDirectories
    .map(
      (directory) =>
        `<li><code>${escapeHtml(folderLabel(record.path, directory.path))}</code><span>${formatBytes(directory.allocatedBytes)}</span></li>`,
    )
    .join("");
  ui.confirmMove.textContent = `Move ${formatBytes(record.generatedAllocatedBytes)} to Trash`;
  ui.dialog.returnValue = "";
  ui.dialog.showModal();
}

async function move(target: MoveTarget): Promise<void> {
  if (!state.mutationToken) return;
  ui.status.textContent = "Moving to Trash…";
  ui.error.hidden = true;
  try {
    const { report, mutationToken, result } = await moveToTrash(target.path, target.directories, state.mutationToken);
    state.mutationToken = mutationToken;
    render(report);
    ui.status.textContent = `Scanned ${formatTime(report.scannedAt)}`;
    // Report what the server actually moved: scanned sizes describe intent, not outcome.
    const skipped = result.warnings.length
      ? ` Skipped ${result.warnings.map((warning) => `${folderLabel(target.path, warning.path)} (${warning.message})`).join(", ")}.`
      : "";
    if (result.moved.length === 0) showNotice(`Nothing moved from ${target.branch}.${skipped}`, "warning");
    else
      showNotice(
        `Moved ${plural(result.moved.length, "folder")} from ${target.branch} to Trash.${skipped}`,
        result.warnings.length ? "warning" : "success",
      );
  } catch (error) {
    showError(error, "Unable to move folders to Trash.");
    ui.status.textContent = "Move failed";
  }
}

ui.dialog.addEventListener("close", () => {
  const target = state.confirming;
  state.confirming = undefined;
  if (ui.dialog.returnValue === "confirm" && target) void enqueue(() => move(target));
});
ui.refresh.addEventListener("click", () => void scan());
let searchFrame = 0;
ui.search.addEventListener("input", () => {
  cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(() => renderList());
});
ui.sort.addEventListener("click", () => {
  state.descending = !state.descending;
  ui.sort.classList.toggle("ascending", !state.descending);
  ui.sort.setAttribute("aria-label", `Sort by generated storage, ${state.descending ? "largest" : "smallest"} first`);
  renderList();
});
for (const button of ui.filters) {
  button.addEventListener("click", () => {
    state.filter = (button.dataset.filter ?? "all") as Filter;
    for (const candidate of ui.filters) candidate.setAttribute("aria-pressed", String(candidate === button));
    renderList();
  });
}

void scan();
