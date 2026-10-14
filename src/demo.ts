import { activityFor, buildReport, generatedCategory, type CategorySizes, type GeneratedDirectory, type ScanReport, type TrashResult, type WorktreeRecord } from "./scanner.ts";

// Demo mode serves a realistic, entirely in-memory workspace so the UI can be shown or shared
// without exposing real paths. Nothing here touches the filesystem.

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const HOME = "/Users/you/Developer";

interface DemoWorktree { repository: string; branch: string; folder?: string; daysAgo: number; dirty?: boolean; source: number; generated: [name: string, bytes: number][]; }

const workspace: DemoWorktree[] = [
  { repository: "storefront", branch: "main", daysAgo: 1, source: 46 * MB, generated: [["node_modules", 1.37 * GB], [".next", 380 * MB], [".turbo", 120 * MB]] },
  { repository: "storefront", branch: "feat/checkout-v2", folder: "storefront-checkout-v2", daysAgo: 64, source: 47 * MB, generated: [["node_modules", 1.61 * GB], [".next", 512 * MB], [".turbo", 210 * MB]] },
  { repository: "storefront", branch: "fix/hydration-flash", folder: "storefront-hydration", daysAgo: 41, source: 46 * MB, generated: [["node_modules", 1.35 * GB], [".next", 290 * MB]] },
  { repository: "storefront", branch: "exp/rsc-migration", folder: "storefront-rsc", daysAgo: 3, dirty: true, source: 51 * MB, generated: [["node_modules", 1.48 * GB], [".next", 440 * MB]] },
  { repository: "ledger-api", branch: "main", daysAgo: 2, source: 18 * MB, generated: [["target", 4.2 * GB]] },
  { repository: "ledger-api", branch: "perf/batch-writes", folder: "ledger-api-batch", daysAgo: 97, source: 18 * MB, generated: [["target", 4.98 * GB]] },
  { repository: "ledger-api", branch: "chore/bump-tokio", folder: "ledger-api-tokio", daysAgo: 18, dirty: true, source: 18 * MB, generated: [["target", 3.71 * GB]] },
  { repository: "vision-lab", branch: "main", daysAgo: 12, source: 92 * MB, generated: [[".venv", 2.83 * GB], [".cache", 760 * MB]] },
  { repository: "vision-lab", branch: "spike/onnx-export", folder: "vision-lab-onnx", daysAgo: 132, source: 88 * MB, generated: [[".venv", 3.03 * GB], [".cache", 1.17 * GB]] },
  { repository: "design-system", branch: "main", daysAgo: 5, source: 31 * MB, generated: [["node_modules", 980 * MB], ["dist", 64 * MB], [".turbo", 48 * MB]] },
  { repository: "design-system", branch: "feat/tokens-v3", folder: "design-system-tokens", daysAgo: 37, source: 31 * MB, generated: [["node_modules", 1020 * MB], ["dist", 72 * MB], ["coverage", 38 * MB]] },
];

function emptySizes(): CategorySizes { return { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 }; }

function demoRecord(entry: DemoWorktree, copy: number, now: number): WorktreeRecord {
  const suffix = copy === 0 ? "" : `-${copy + 1}`;
  const repositoryPath = `${HOME}/${entry.repository}${suffix}`;
  const path = entry.folder ? `${HOME}/${entry.folder}${suffix}` : repositoryPath;
  const sizes = emptySizes(); const allocatedSizes = emptySizes();
  sizes.sourceOther = entry.source; allocatedSizes.sourceOther = entry.source;
  const generatedDirectories: GeneratedDirectory[] = entry.generated.map(([name, bytes]) => {
    const category = generatedCategory(name);
    if (category === "sourceOther") throw new Error(`Demo folder ${name} is not a recognised generated directory`);
    // Small files round up to whole blocks, so allocated storage sits slightly above logical size.
    const allocatedBytes = Math.round(bytes); const logicalBytes = Math.round(bytes * 0.97);
    sizes[category] += logicalBytes; allocatedSizes[category] += allocatedBytes;
    return { path: `${path}/${name}`, name, category, logicalBytes, allocatedBytes };
  });
  const base = {
    repositoryId: `demo:${entry.repository}${suffix}`, repositoryPath, branch: entry.branch, path,
    status: entry.dirty ? "dirty" as const : "clean" as const, lastCommitAt: now - (entry.daysAgo + copy % 9) * 86_400_000,
    sizes, allocatedSizes,
    totalBytes: Object.values(sizes).reduce((sum, value) => sum + value, 0), allocatedBytes: Object.values(allocatedSizes).reduce((sum, value) => sum + value, 0),
    generatedBytes: sizes.dependencies + sizes.buildOutput + sizes.caches, generatedAllocatedBytes: allocatedSizes.dependencies + allocatedSizes.buildOutput + allocatedSizes.caches,
    generatedDirectories, warnings: [],
  };
  return { ...base, activity: activityFor(base) };
}

/** A believable workspace; `worktreeCount` repeats it with numbered copies for stress testing. */
export function createDemoReport(options: { worktreeCount?: number } = {}): ScanReport {
  const count = options.worktreeCount ?? workspace.length; const now = Date.now();
  const worktrees = Array.from({ length: count }, (_, index) => demoRecord(workspace[index % workspace.length]!, Math.floor(index / workspace.length), now));
  const repositories = [...new Map(worktrees.map((record) => [record.repositoryId, { id: record.repositoryId, path: record.repositoryPath }])).values()];
  return buildReport([HOME], repositories, worktrees);
}

/** Mirrors moveGeneratedDirectories: only worktrees from the latest report, and the result is re-summarised. */
export function simulateMove(report: ScanReport, worktreePath: string): { result: TrashResult; report: ScanReport } {
  const target = report.worktrees.find((record) => record.path === worktreePath);
  if (!target) throw new Error("That worktree was not returned by the latest scan.");
  const trashPath = "/Users/you/.Trash/Worktree Diet/demo";
  const moved = target.generatedDirectories.map((directory) => ({ from: directory.path, to: `${trashPath}/${directory.name}` }));
  const sizes = { ...emptySizes(), sourceOther: target.sizes.sourceOther }; const allocatedSizes = { ...emptySizes(), sourceOther: target.allocatedSizes.sourceOther };
  const base = { ...target, sizes, allocatedSizes, totalBytes: sizes.sourceOther, allocatedBytes: allocatedSizes.sourceOther, generatedBytes: 0, generatedAllocatedBytes: 0, generatedDirectories: [] };
  const worktrees = report.worktrees.map((record) => record === target ? { ...base, activity: activityFor(base) } : record);
  return { result: { moved, warnings: [], trashPath }, report: buildReport(report.roots, report.repositories, worktrees) };
}
