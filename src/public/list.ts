import type { WorktreeRecord } from "../scanner.ts";
import { age, formatBytes } from "./format.ts";
import { locationLine, stateLabels } from "./model.ts";

const INTRO_ROWS = 14;
const ROW_CELL_PITCH = 8; // must match the .size-bar mask in styles.css

/**
 * The worktree listbox. Rows are built once per report and reused, so search, filters and sorting only
 * reorder nodes. It is a single tab stop: arrow keys, Home and End move the selection.
 */
export class WorktreeList {
  readonly #list: HTMLElement;
  readonly #template: HTMLTemplateElement;
  readonly #records = new WeakMap<Element, WorktreeRecord>();
  #rows = new Map<string, HTMLButtonElement>();
  #largest = 1;
  #selected: string | undefined;
  #tabStop: HTMLButtonElement | undefined;

  constructor(list: HTMLElement, template: HTMLTemplateElement, onSelect: (record: WorktreeRecord) => void) {
    this.#list = list;
    this.#template = template;
    list.addEventListener("click", (event) => {
      const row = event.target instanceof Element ? event.target.closest(".worktree-row") : null;
      const record = row && this.#records.get(row);
      if (record) onSelect(record);
    });
    list.addEventListener("keydown", (event) => this.#navigate(event));
  }

  build(records: readonly WorktreeRecord[], ambiguous: ReadonlySet<string>, selectedPath: string | undefined): void {
    // Bars share one scale across the whole report so filtering never rescales them.
    this.#largest = Math.max(1, ...records.map((record) => record.generatedAllocatedBytes));
    this.#selected = selectedPath;
    this.#tabStop = undefined;
    this.#rows = new Map(records.map((record) => [record.path, this.#buildRow(record, ambiguous)]));
  }

  show(records: readonly WorktreeRecord[], intro: boolean): void {
    const rows = records.flatMap((record) => this.#rows.get(record.path) ?? []);
    const shown = new Set(rows);
    // Search and filters only toggle `hidden`; detaching and re-inserting every row cost about twice the
    // style and layout work (400 rows: 60ms -> 38ms to clear a search). The DOM is reordered only when the
    // order itself changes, a sort or a new report, so DOM order stays the visual order screen readers follow.
    const inOrder = [...this.#list.children].filter((child) => shown.has(child as HTMLButtonElement));
    if (inOrder.length !== rows.length || inOrder.some((row, index) => row !== rows[index]))
      this.#list.replaceChildren(...rows, ...[...this.#rows.values()].filter((row) => !shown.has(row)));
    for (const row of this.#rows.values()) if (row.hidden === shown.has(row)) row.hidden = !shown.has(row);
    const selected = this.#selected === undefined ? undefined : this.#rows.get(this.#selected);
    this.#setTabStop(selected && shown.has(selected) ? selected : rows[0]);
    if (intro) this.#growBars(records);
  }

  select(path: string): void {
    const previous = this.#selected === undefined ? undefined : this.#rows.get(this.#selected);
    previous?.setAttribute("aria-selected", "false");
    this.#selected = path;
    const next = this.#rows.get(path);
    next?.setAttribute("aria-selected", "true");
    this.#setTabStop(next);
  }

  /** Exactly one row is reachable with Tab; every other row is -1 from the moment it is built. */
  #setTabStop(row: HTMLButtonElement | undefined): void {
    if (row === this.#tabStop) return;
    if (this.#tabStop) this.#tabStop.tabIndex = -1;
    if (row) row.tabIndex = 0;
    this.#tabStop = row;
  }

  #buildRow(record: WorktreeRecord, ambiguous: ReadonlySet<string>): HTMLButtonElement {
    const row = this.#template.content.firstElementChild?.cloneNode(true);
    if (!(row instanceof HTMLButtonElement)) throw new Error("The row template must contain a button");
    const [identity, evidence, ageCell, storage] = row.children;
    row.classList.add(record.activity.state);
    row.title = record.path;
    row.setAttribute("aria-selected", String(record.path === this.#selected));
    row.tabIndex = -1;
    if (identity?.firstElementChild) identity.firstElementChild.textContent = record.branch;
    if (identity?.lastElementChild) identity.lastElementChild.textContent = locationLine(record, ambiguous);
    const state = document.createElement("span");
    state.className = `state ${record.activity.state}`;
    state.textContent = stateLabels[record.activity.state];
    evidence?.append(state);
    if (ageCell) ageCell.textContent = age(record.lastCommitAt);
    const bar = storage?.querySelector<HTMLElement>(".size-bar i");
    bar?.style.setProperty("--fraction", String(this.#fraction(record)));
    if (storage?.lastElementChild) storage.lastElementChild.textContent = formatBytes(record.generatedAllocatedBytes);
    this.#records.set(row, record);
    return row;
  }

  #fraction(record: WorktreeRecord): number {
    return Math.max(0.005, record.generatedAllocatedBytes / this.#largest);
  }

  /** First paint only: bars on the first screen of rows grow in, one cell per step. */
  #growBars(records: readonly WorktreeRecord[]): void {
    this.#list.classList.add("is-intro");
    const track = this.#list.querySelector(".size-bar")?.clientWidth ?? 0;
    for (const [index, record] of records.slice(0, INTRO_ROWS).entries()) {
      const bar = this.#rows.get(record.path)?.querySelector<HTMLElement>(".size-bar i");
      bar?.style.setProperty(
        "--cells",
        String(Math.max(1, Math.ceil((this.#fraction(record) * track) / ROW_CELL_PITCH))),
      );
      bar?.style.setProperty("--i", String(index));
    }
    setTimeout(() => this.#list.classList.remove("is-intro"), 1800);
  }

  #navigate(event: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...this.#list.querySelectorAll<HTMLButtonElement>(".worktree-row:not([hidden])")];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const last = rows.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? Math.min(last, current + 1)
            : Math.max(0, current - 1);
    const row = rows[next];
    if (!row) return;
    event.preventDefault();
    row.focus();
    row.click();
  }
}
