import type { WorktreeRecord } from "../src/scanner.ts";
import { activityFor } from "../src/scanner.ts";

export const DAY = 86_400_000;
export const now = Date.UTC(2026, 9, 1);

/** A plausible worktree record; overrides win, and `activity` is derived unless given. */
export function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const path = overrides.path ?? "/work/storefront";
  const base = {
    repositoryId: "repo",
    repositoryPath: "/work/storefront",
    branch: "main",
    path,
    status: "clean" as const,
    lastCommitAt: now - 2 * DAY,
    sizes: { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 },
    allocatedSizes: { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 },
    totalBytes: 0,
    allocatedBytes: 0,
    generatedBytes: 100,
    generatedAllocatedBytes: 100,
    generatedDirectories: [
      { path: `${path}/dist`, name: "dist", category: "buildOutput" as const, logicalBytes: 100, allocatedBytes: 100 },
    ],
    warnings: [],
    ...overrides,
  };
  return { ...base, activity: overrides.activity ?? activityFor(base, now) };
}
