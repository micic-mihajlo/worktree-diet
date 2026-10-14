import { describe, expect, test } from "bun:test";
import { age, byteParts, escapeHtml } from "../src/public/format.ts";
import {
  apportionCells,
  filterRecords,
  findAmbiguousPaths,
  folderLabel,
  locationLine,
  verdict,
} from "../src/public/model.ts";
import type { ActivityCause, WorktreeRecord } from "../src/scanner.ts";
import { activityFor } from "../src/scanner.ts";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 1);

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const base = {
    repositoryId: "repo",
    repositoryPath: "/work/storefront",
    branch: "main",
    path: "/work/storefront",
    status: "clean" as const,
    lastCommitAt: now - 2 * DAY,
    sizes: { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 },
    allocatedSizes: { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 },
    totalBytes: 0,
    allocatedBytes: 0,
    generatedBytes: 100,
    generatedAllocatedBytes: 100,
    generatedDirectories: [
      {
        path: "/work/storefront/dist",
        name: "dist",
        category: "buildOutput" as const,
        logicalBytes: 100,
        allocatedBytes: 100,
      },
    ],
    warnings: [],
    ...overrides,
  };
  return { ...base, activity: overrides.activity ?? activityFor(base, now) };
}

describe("byte formatting", () => {
  test("uses three significant figures", () => {
    expect(byteParts(0)).toEqual(["0", "B"]);
    expect(byteParts(1023)).toEqual(["1023", "B"]);
    expect(byteParts(1536)).toEqual(["1.5", "KB"]);
    expect(byteParts(512 * 1024 ** 2)).toEqual(["512", "MB"]);
    expect(byteParts(4.98 * 1024 ** 3)).toEqual(["4.98", "GB"]);
    expect(byteParts(14.24 * 1024 ** 3)).toEqual(["14.2", "GB"]);
  });
  test("rolls over to the next unit instead of showing 1024", () => {
    expect(byteParts(1024 ** 2 - 1)).toEqual(["1", "MB"]);
    expect(byteParts(1024 ** 3 - 300 * 1024)).toEqual(["1", "GB"]);
  });
});

describe("escapeHtml", () => {
  test("escapes quotes as well as markup, so it is safe inside attributes", () => {
    expect(escapeHtml(`a" onmouseover="alert(1)`)).toBe("a&quot; onmouseover=&quot;alert(1)");
    expect(escapeHtml(`<b>'&'</b>`)).toBe("&lt;b&gt;&#39;&amp;&#39;&lt;/b&gt;");
  });
});

describe("age", () => {
  test.each([
    [null, "Unknown"],
    [0, "Today"],
    [1, "Yesterday"],
    [13, "13 days ago"],
    [14, "2 weeks ago"],
    [59, "8 weeks ago"],
    [60, "2 months ago"],
    [364, "12 months ago"],
    [365, "1 year ago"],
    [800, "2 years ago"],
  ])("%p days", (days, expected) => {
    expect(age(days === null ? null : now - days * DAY, now)).toBe(expected);
  });
});

describe("apportionCells", () => {
  test("always fills exactly the available cells", () => {
    for (const values of [
      [1, 1, 1],
      [5, 3, 2, 0],
      [1000, 1, 1],
      [0.3, 0.3, 0.4],
    ])
      expect(apportionCells(values, 75).reduce((sum, count) => sum + count, 0)).toBe(75);
  });
  test("gives any non-zero value at least one cell", () => {
    expect(apportionCells([1_000_000, 1, 0], 10)).toEqual([9, 1, 0]);
  });
  test("returns zeros when there is nothing to show", () => {
    expect(apportionCells([0, 0], 10)).toEqual([0, 0]);
    expect(apportionCells([1, 2], 0)).toEqual([0, 0]);
  });
});

describe("worktree labels", () => {
  test("names the folder only when it differs from the repository", () => {
    expect(locationLine(record(), new Set())).toBe("storefront");
    expect(locationLine(record({ path: "/work/storefront-checkout" }), new Set())).toBe(
      "storefront · storefront-checkout",
    );
  });
  test("falls back to full paths for worktrees that would read identically", () => {
    const a = record({ repositoryPath: "/clients/a/app", path: "/clients/a/app" });
    const b = record({ repositoryPath: "/clients/b/app", path: "/clients/b/app" });
    const c = record({ repositoryPath: "/clients/c/web", path: "/clients/c/web" });
    const ambiguous = findAmbiguousPaths([a, b, c]);
    expect([...ambiguous].sort()).toEqual(["/clients/a/app", "/clients/b/app"]);
    expect(locationLine(a, ambiguous)).toBe("/clients/a/app");
    expect(locationLine(c, ambiguous)).toBe("web");
  });
  test("labels nested generated folders by their path inside the worktree", () => {
    expect(folderLabel(record(), "/work/storefront/packages/web/dist")).toBe("packages/web/dist");
  });
});

describe("filterRecords", () => {
  const records = [
    record({ branch: "feat/checkout", path: "/work/a", generatedAllocatedBytes: 300 }),
    record({ branch: "main", path: "/work/b", generatedAllocatedBytes: 100, status: "dirty" }),
    record({ branch: "fix/flash", path: "/work/c", generatedAllocatedBytes: 200 }),
  ];
  test("sorts by generated storage in either direction", () => {
    const options = { filter: "all" as const, query: "" };
    expect(filterRecords(records, { ...options, descending: true }).map((r) => r.path)).toEqual([
      "/work/a",
      "/work/c",
      "/work/b",
    ]);
    expect(filterRecords(records, { ...options, descending: false }).map((r) => r.path)).toEqual([
      "/work/b",
      "/work/c",
      "/work/a",
    ]);
  });
  test("filters by state and by a case-insensitive query over branch and paths", () => {
    expect(filterRecords(records, { filter: "review", query: "", descending: true }).map((r) => r.branch)).toEqual([
      "main",
    ]);
    expect(
      filterRecords(records, { filter: "all", query: " CHECKOUT ", descending: true }).map((r) => r.branch),
    ).toEqual(["feat/checkout"]);
    expect(filterRecords(records, { filter: "all", query: "storefront", descending: true })).toHaveLength(3);
  });
});

describe("verdict", () => {
  const causes: Record<ActivityCause, Partial<WorktreeRecord>> = {
    idle: { lastCommitAt: now - 45 * DAY },
    dirty: { status: "dirty" },
    "no-commit-time": { lastCommitAt: null },
    "nothing-to-reclaim": {},
    "status-unknown": { status: "unknown", lastCommitAt: now - 45 * DAY },
    aging: { lastCommitAt: now - 12 * DAY },
    active: {},
  };
  test.each(Object.entries(causes))("explains %s", (cause, overrides) => {
    const subject = record(overrides);
    const activity = { ...subject.activity, cause: cause as ActivityCause };
    const text = verdict({ ...subject, activity }, now);
    expect(text.length).toBeGreaterThan(10);
    if (cause === "idle") expect(text).toContain("45 days");
    if (cause === "aging") expect(text).toContain("12 days");
  });
  test("says there is nothing to reclaim when no generated folders remain", () => {
    expect(verdict(record({ generatedDirectories: [], generatedAllocatedBytes: 0 }), now)).toBe(
      "Nothing generated here to reclaim.",
    );
  });
});
