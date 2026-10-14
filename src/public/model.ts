// Pure view logic over the scan report. No DOM access, so it can be unit tested.
import type { ActivityState, GeneratedCategory, ScanReport, WorktreeRecord } from "../scanner.ts";
import { baseName, daysSince } from "./format.ts";

export type Filter = ActivityState | "all";
export const states: readonly ActivityState[] = ["likely-inactive", "review", "recent"];
export const stateLabels: Record<ActivityState, string> = {
  "likely-inactive": "Ready to clean",
  review: "Needs review",
  recent: "Recently active",
};
export const categoryLabels: Record<GeneratedCategory, string> = {
  dependencies: "Dependencies",
  buildOutput: "Build output",
  caches: "Cache",
};

export function stateTotals(report: ScanReport): Record<ActivityState, { bytes: number; count: number }> {
  const totals = {
    "likely-inactive": { bytes: 0, count: 0 },
    review: { bytes: 0, count: 0 },
    recent: { bytes: 0, count: 0 },
  };
  for (const record of report.worktrees) {
    totals[record.activity.state].bytes += record.generatedAllocatedBytes;
    totals[record.activity.state].count += 1;
  }
  return totals;
}

export function filterRecords(
  records: readonly WorktreeRecord[],
  { filter, query, descending }: { filter: Filter; query: string; descending: boolean },
): WorktreeRecord[] {
  const needle = query.trim().toLowerCase();
  return records
    .filter((record) => filter === "all" || record.activity.state === filter)
    .filter(
      (record) => !needle || `${record.branch} ${record.repositoryPath} ${record.path}`.toLowerCase().includes(needle),
    )
    .sort((left, right) => (descending ? -1 : 1) * (left.generatedAllocatedBytes - right.generatedAllocatedBytes));
}

/** "storefront · storefront-checkout-v2", naming the folder only when it differs from the repository. */
function shortLocation(record: WorktreeRecord): string {
  const repository = baseName(record.repositoryPath);
  const folder = baseName(record.path);
  return folder === repository ? repository : `${repository} · ${folder}`;
}

/** Worktrees whose branch and short location would read identically, so they need their full path. */
export function findAmbiguousPaths(records: readonly WorktreeRecord[]): Set<string> {
  const key = (record: WorktreeRecord) => `${record.branch}\n${shortLocation(record)}`;
  const counts = new Map<string, number>();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return new Set(records.filter((record) => (counts.get(key(record)) ?? 0) > 1).map((record) => record.path));
}

export const locationLine = (record: WorktreeRecord, ambiguous: ReadonlySet<string>): string =>
  ambiguous.has(record.path) ? record.path : shortLocation(record);

/** Nested generated folders can share a name (packages/web/dist, packages/docs/dist), so show where each lives. */
export const folderLabel = (worktreePath: string, path: string): string =>
  path.startsWith(`${worktreePath}/`) ? path.slice(worktreePath.length + 1) : baseName(path);

/** One sentence explaining the recommendation, from the cause the scanner reported. */
export function verdict(record: WorktreeRecord, now = Date.now()): string {
  if (record.generatedDirectories.length === 0) return "Nothing generated here to reclaim.";
  const days = record.lastCommitAt === null ? 0 : daysSince(record.lastCommitAt, now);
  switch (record.activity.cause) {
    case "idle":
      return `Clean, and nobody has committed here in ${days} days. Its generated folders are safe to move — reinstall if you come back.`;
    case "dirty":
      return "Has uncommitted changes. Moving generated folders won’t touch them, but you may still be working here.";
    case "no-commit-time":
      return "Couldn’t read the last commit time, so there’s no evidence either way. Check it before cleaning.";
    case "nothing-to-reclaim":
      return "Nothing generated here to reclaim.";
    case "status-unknown":
      return "Couldn’t read Git status, so uncommitted work can’t be ruled out. Check it before cleaning.";
    case "aging":
      return `Last commit was ${days} days ago — past this week, but not idle long enough to call inactive. Worth a quick look first.`;
    case "active":
      return "Committed to this week — expect to reinstall dependencies if you clean it.";
  }
}

/** Splits `cells` between `values` by largest remainder, giving any non-zero value at least one cell. */
export function apportionCells(values: readonly number[], cells: number): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || cells <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * cells);
  const counts = exact.map(Math.floor);
  const byRemainder = exact
    .map((value, index) => ({ remainder: value - Math.floor(value), index }))
    .sort((left, right) => right.remainder - left.remainder);
  let remaining = cells - counts.reduce((sum, count) => sum + count, 0);
  for (let position = 0; remaining > 0; position += 1, remaining -= 1) {
    const index = byRemainder[position % byRemainder.length]?.index ?? 0;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  for (const [index, value] of values.entries()) {
    if (value <= 0 || (counts[index] ?? 0) > 0) continue;
    const donor = counts.indexOf(Math.max(...counts));
    if ((counts[donor] ?? 0) > 1) {
      counts[donor] = (counts[donor] ?? 0) - 1;
      counts[index] = 1;
    }
  }
  return counts;
}
