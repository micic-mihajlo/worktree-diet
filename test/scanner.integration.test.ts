import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activityFor,
  generatedCategory,
  moveGeneratedDirectories,
  parseWorktreeList,
  scanRepository,
  scanWorkspace,
} from "../src/scanner.ts";
import { cleanTemporaryRoots, git, makeRepository, temporaryDirectory } from "./helpers.ts";

afterEach(cleanTemporaryRoots);

describe("workspace scanner", () => {
  test("discovers linked worktrees, classifies real files, and reports dirty state", async () => {
    const { root, linked } = await makeRepository();
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, ".turbo"), { recursive: true });
    await writeFile(join(root, "node_modules", "package.bin"), "12345");
    await writeFile(join(root, "dist", "bundle.js"), "1234");
    await writeFile(join(root, ".turbo", "cache.bin"), "123");
    await writeFile(join(root, "source.ts"), "12");
    await writeFile(join(linked, "changed.txt"), "dirty");
    const report = await scanRepository(root);
    expect(report.worktrees).toHaveLength(2);
    expect(report.totals.dependencies).toBe(5);
    expect(report.totals.buildOutput).toBe(4);
    expect(report.totals.caches).toBe(3);
    expect(report.totals.sourceOther).toBeGreaterThanOrEqual(7);
    expect(report.generatedBytes).toBe(12);
    expect(report.generatedAllocatedBytes).toBeGreaterThan(0);
    expect(report.worktrees.find((worktree) => worktree.branch === "feature")?.status).toBe("dirty");
    expect(
      report.worktrees.flatMap((worktree) => worktree.generatedDirectories.map((directory) => directory.name)),
    ).toContain("node_modules");
  });
  test("discovers repositories from multiple parents and deduplicates shared worktrees", async () => {
    const parent = await temporaryDirectory("worktree-diet-parent-");
    const first = await makeRepository(parent);
    const second = await makeRepository(parent);
    await mkdir(join(first.linked, "dist"));
    await writeFile(join(first.linked, "dist", "artifact.bin"), "generated");
    const report = await scanWorkspace([parent, first.root, second.linked]);
    expect(report.repositories).toHaveLength(2);
    expect(report.worktrees).toHaveLength(4);
    expect(new Set(report.worktrees.map((worktree) => worktree.path)).size).toBe(4);
    expect(report.generatedBytes).toBe("generated".length);
  });
  test("prefers repositories inside a parent directory even when that parent sits in another repository", async () => {
    const outer = await temporaryDirectory("worktree-diet-outer-");
    await git(outer, "init");
    const parent = join(outer, "repositories");
    await mkdir(parent);
    const nested = await makeRepository(parent);
    const report = await scanWorkspace([parent]);
    expect(report.repositories).toHaveLength(1);
    expect(report.repositories[0]?.path).toBe(await realpath(nested.root));
    expect(report.worktrees).toHaveLength(2);
  });
  test("does not count nested linked worktrees while measuring their parent", async () => {
    const { root, linked } = await makeRepository();
    await writeFile(join(root, "parent.txt"), "parent");
    await writeFile(join(linked, "linked.txt"), "linked");
    const report = await scanRepository(root);
    const canonicalRoot = await realpath(root);
    const parent = report.worktrees.find((worktree) => worktree.path === canonicalRoot);
    expect(parent?.sizes.sourceOther).toBe("main\nparent".length);
    expect(report.totals.sourceOther).toBeGreaterThan(parent?.sizes.sourceOther ?? 0);
  });
  test("suggests only outermost generated directories", async () => {
    const { root } = await makeRepository();
    await mkdir(join(root, "node_modules", "package", "nested"), { recursive: true });
    await mkdir(join(root, "dist", "assets", "nested"), { recursive: true });
    await mkdir(join(root, ".turbo", "cache", "nested"), { recursive: true });
    await writeFile(join(root, "node_modules", "package", "nested", "index.js"), "dependency");
    await writeFile(join(root, "dist", "assets", "nested", "bundle.js"), "build");
    await writeFile(join(root, ".turbo", "cache", "nested", "entry"), "cache");
    const report = await scanRepository(root);
    const canonicalRoot = await realpath(root);
    const parent = report.worktrees.find((worktree) => worktree.path === canonicalRoot);
    expect(parent?.generatedDirectories.map((directory) => directory.name).sort()).toEqual([
      ".turbo",
      "dist",
      "node_modules",
    ]);
  });
  test("deduplicates hardlinked generated files when inode data is available", async () => {
    const { root } = await makeRepository();
    await mkdir(join(root, "node_modules", "a"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    const original = join(root, "node_modules", "a", "package.bin");
    await writeFile(original, "x".repeat(2048));
    await link(original, join(root, "dist", "package-copy.bin"));
    const report = await scanRepository(root);
    expect(report.generatedBytes).toBe(2048);
    expect(report.generatedAllocatedBytes).toBeGreaterThan(0);
  });
  test("does not follow symlinked directories", async () => {
    const { root } = await makeRepository();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "large.bin"), "x".repeat(4096));
    await symlink(outside, join(root, "node_modules"));
    const report = await scanRepository(root);
    expect(report.totals.dependencies).toBe(0);
    expect(
      report.warnings.some(
        (warning) => warning.path.endsWith("node_modules") && warning.message.includes("symbolic link"),
      ),
    ).toBe(true);
  });
  test("explains heuristic state with explicit Git and age evidence", async () => {
    const { root, linked } = await makeRepository();
    await mkdir(join(linked, "dist"));
    await writeFile(join(linked, "dist", "bundle"), "artifact");
    await git(linked, "add", "dist");
    await git(linked, "commit", "-m", "generated fixture");
    const report = await scanRepository(root);
    const canonicalLinked = await realpath(linked);
    const record = report.worktrees.find((worktree) => worktree.path === canonicalLinked);
    expect(record?.activity.state).toBe("recent");
    expect(record?.activity.cause).toBe("active");
    expect(record?.activity.reasons.some((reason) => reason.includes("Git status is clean"))).toBe(true);
    expect(record?.activity.reasons.some((reason) => reason.includes("Last commit was"))).toBe(true);
  });
  test("moves only scanned generated directories to a temporary Trash root", async () => {
    const { root } = await makeRepository();
    const trash = await temporaryDirectory("worktree-diet-trash-");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle"), "artifact");
    await writeFile(join(root, "keep.txt"), "source");
    const report = await scanRepository(root);
    const result = await moveGeneratedDirectories(report, root, { trashRoot: trash });
    expect(result.moved).toHaveLength(1);
    expect(await Bun.file(join(root, "keep.txt")).text()).toBe("source");
    expect(await Bun.file(join(root, "dist")).exists()).toBe(false);
    expect(await Bun.file(join(result.moved[0]?.to ?? "", "bundle")).text()).toBe("artifact");
  });
  test("rejects an unscanned worktree path at the trash boundary", async () => {
    const { root } = await makeRepository();
    const outside = await temporaryDirectory("worktree-diet-outside-");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle"), "artifact");
    const report = await scanRepository(root);
    await expect(moveGeneratedDirectories(report, outside, { trashRoot: join(outside, "trash") })).rejects.toThrow(
      "latest scan",
    );
    expect(await Bun.file(join(root, "dist", "bundle")).exists()).toBe(true);
  });
  test("skips a worktree whose folder was deleted without pruning, instead of failing the scan", async () => {
    const { root, linked } = await makeRepository();
    await rm(linked, { recursive: true, force: true });
    const report = await scanRepository(root);
    expect(report.worktrees.map((worktree) => worktree.path)).toEqual([await realpath(root)]);
    expect(report.warnings.some((warning) => warning.path === linked && warning.message.includes("missing"))).toBe(
      true,
    );
  });
  test("treats folders named like Object.prototype members as source, not generated", async () => {
    const { root } = await makeRepository();
    for (const name of ["constructor", "toString", "__proto__"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "file.ts"), "source");
    }
    const report = await scanRepository(root);
    expect(report.worktrees.flatMap((worktree) => worktree.generatedDirectories)).toEqual([]);
    expect(generatedCategory("constructor")).toBe("sourceOther");
    expect(generatedCategory("node_modules")).toBe("dependencies");
  });
  test("attributes a file hardlinked across worktrees to its alphabetically first path, on every scan", async () => {
    const { root, linked } = await makeRepository();
    await mkdir(join(root, "node_modules"));
    await mkdir(join(linked, "node_modules"));
    await writeFile(join(root, "node_modules", "shared.bin"), "x".repeat(4096));
    await link(join(root, "node_modules", "shared.bin"), join(linked, "node_modules", "shared.bin"));
    // "<root>/feature worktree/…" sorts before "<root>/node_modules/…", so the linked worktree owns it.
    const owner = await realpath(linked);
    for (let scan = 0; scan < 5; scan++) {
      const report = await scanRepository(root);
      expect(report.generatedBytes).toBe(4096);
      for (const worktree of report.worktrees) expect(worktree.generatedBytes).toBe(worktree.path === owner ? 4096 : 0);
    }
  });
  test("skips a folder whose parent was swapped for a symlink after the scan", async () => {
    const { root } = await makeRepository();
    const outside = await temporaryDirectory("worktree-diet-outside-");
    await mkdir(join(root, "packages", "app", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "app", "dist", "bundle"), "inside");
    const report = await scanRepository(root);
    await mkdir(join(outside, "app", "dist"), { recursive: true });
    await writeFile(join(outside, "app", "dist", "bundle"), "outside");
    await rename(join(root, "packages"), join(root, "packages-moved"));
    await symlink(outside, join(root, "packages"));
    const result = await moveGeneratedDirectories(report, root, { trashRoot: join(outside, "trash") });
    expect(result.moved).toEqual([]);
    expect(result.warnings[0]?.message).toContain("location changed");
    expect(await Bun.file(join(outside, "app", "dist", "bundle")).text()).toBe("outside");
  });
  test("creates no Trash folder when nothing is moved", async () => {
    const { root } = await makeRepository();
    const trash = await temporaryDirectory("worktree-diet-trash-");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle"), "artifact");
    const report = await scanRepository(root);
    await rm(join(root, "dist"), { recursive: true });
    const result = await moveGeneratedDirectories(report, root, { trashRoot: trash });
    expect(result.moved).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(await readdir(trash)).toEqual([]);
  });
  test("counts a worktree nested inside another repository once", async () => {
    const parent = await temporaryDirectory("worktree-diet-parent-");
    const a = join(parent, "A");
    const b = join(parent, "B");
    for (const path of [a, b]) {
      await mkdir(path);
      await git(path, "init");
      await git(path, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    }
    await git(a, "worktree", "add", "-b", "nested", join(b, "wt-a"));
    await mkdir(join(b, "wt-a", "node_modules"));
    await writeFile(join(b, "wt-a", "node_modules", "package.bin"), "x".repeat(10_000));
    const report = await scanWorkspace([parent]);
    expect(report.generatedBytes).toBe(10_000);
    const ownerOf = (directory: string) =>
      report.worktrees.filter((worktree) => worktree.generatedDirectories.some((d) => d.path.endsWith(directory)));
    expect(ownerOf("wt-a/node_modules").map((worktree) => worktree.branch)).toEqual(["nested"]);
  });
  test("never offers a generated folder that contains another worktree", async () => {
    const { root } = await makeRepository();
    const hotfix = join(root, "build", "hotfix");
    await git(root, "worktree", "add", "-b", "hotfix", hotfix);
    await writeFile(join(hotfix, "uncommitted.txt"), "work in progress");
    await writeFile(join(root, "build", "output.js"), "built");
    const report = await scanRepository(root);
    const main = report.worktrees.find((worktree) => worktree.path === report.repositories[0]?.path);
    expect(main?.generatedDirectories.map((directory) => directory.name)).not.toContain("build");
    expect(report.warnings.some((warning) => warning.message.includes("contains the worktree"))).toBe(true);

    // Even if a report did list it, the move refuses rather than carrying the worktree into Trash.
    const buildPath = join(await realpath(root), "build");
    const tampered = {
      ...report,
      worktrees: report.worktrees.map((worktree) =>
        worktree === main
          ? {
              ...worktree,
              generatedDirectories: [
                {
                  path: buildPath,
                  name: "build",
                  category: "buildOutput" as const,
                  logicalBytes: 5,
                  allocatedBytes: 5,
                },
              ],
            }
          : worktree,
      ),
    };
    const trashRoot = await temporaryDirectory("worktree-diet-trash-");
    const result = await moveGeneratedDirectories(tampered, root, { trashRoot });
    expect(result.moved).toEqual([]);
    expect(result.warnings[0]?.message).toContain("contains the worktree");
    expect(await Bun.file(join(hotfix, "uncommitted.txt")).text()).toBe("work in progress");
  });
  test("warns about a repository Git cannot read instead of silently dropping it", async () => {
    const parent = await temporaryDirectory("worktree-diet-parent-");
    const healthy = await makeRepository(parent);
    const broken = join(parent, "broken");
    await mkdir(broken);
    await writeFile(join(broken, ".git"), "gitdir: /nonexistent/worktree\n");
    const report = await scanWorkspace([parent]);
    expect(report.repositories.map((repository) => repository.path)).toEqual([await realpath(healthy.root)]);
    expect(
      report.warnings.some(
        (warning) => warning.path === broken && warning.message.startsWith("Could not read this repository"),
      ),
    ).toBe(true);
  });
  test("moves only the confirmed folders that are still in the scan", async () => {
    const { root } = await makeRepository();
    for (const name of ["dist", "node_modules"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "file"), name);
    }
    const report = await scanRepository(root);
    const canonical = await realpath(root);
    const trashRoot = await temporaryDirectory("worktree-diet-trash-");
    const result = await moveGeneratedDirectories(report, root, {
      trashRoot,
      confirmed: [join(canonical, "dist"), join(canonical, ".next")],
    });
    expect(result.moved.map((move) => move.from)).toEqual([join(canonical, "dist")]);
    expect(result.warnings).toEqual([
      { path: join(canonical, ".next"), message: "Skipped because it is no longer in the latest scan" },
    ]);
    expect(await Bun.file(join(root, "node_modules", "file")).text()).toBe("node_modules");
  });
  test("never offers a generated folder that holds an independent repository", async () => {
    const { root } = await makeRepository();
    const experiment = join(root, "build", "experiment");
    await mkdir(experiment, { recursive: true });
    await git(experiment, "init");
    await writeFile(join(experiment, "notes.txt"), "uncommitted");
    await writeFile(join(root, "build", "output.js"), "x".repeat(1000));
    const report = await scanRepository(root);
    const main = report.worktrees.find((worktree) => worktree.path === report.repositories[0]?.path);
    expect(main?.generatedDirectories.map((directory) => directory.name)).not.toContain("build");
    // Its bytes count as source, so the totals match what the move would actually free.
    expect(main?.generatedBytes).toBe(0);
    expect(main?.sizes.sourceOther).toBeGreaterThanOrEqual(1000);
    expect(
      report.warnings.some(
        (warning) => warning.path.endsWith("/build") && warning.message.includes("contains a Git repository"),
      ),
    ).toBe(true);
  });
  test("refuses to move a folder that gained a repository or worktree after the scan", async () => {
    const { root } = await makeRepository();
    for (const name of ["dist", "node_modules"]) {
      await mkdir(join(root, name, "nested"), { recursive: true });
      await writeFile(join(root, name, "nested", "file.js"), name);
    }
    const report = await scanRepository(root);
    expect(report.worktrees.flatMap((worktree) => worktree.generatedDirectories.map((d) => d.name)).sort()).toEqual([
      "dist",
      "node_modules",
    ]);
    // After the scan: a linked worktree appears inside dist, and an independent repository inside node_modules.
    await git(root, "worktree", "add", "-b", "late", join(root, "dist", "late"));
    await writeFile(join(root, "dist", "late", "work.txt"), "uncommitted");
    await git(join(root, "node_modules", "nested"), "init");
    const trashRoot = await temporaryDirectory("worktree-diet-trash-");
    const result = await moveGeneratedDirectories(report, root, { trashRoot });
    expect(result.moved).toEqual([]);
    expect(result.warnings.map((warning) => warning.message.includes("contains a Git repository"))).toEqual([
      true,
      true,
    ]);
    expect(await Bun.file(join(root, "dist", "late", "work.txt")).text()).toBe("uncommitted");
    expect(await Bun.file(join(root, "node_modules", "nested", "file.js")).text()).toBe("node_modules");
  });
  test("returns a useful error for non-Git input", async () => {
    const path = await temporaryDirectory("worktree-diet-not-git-");
    await expect(scanRepository(path)).rejects.toThrow("Not a Git repository");
  });
});

describe("worktree list parsing", () => {
  test("reads branches, detached and bare entries, and ignores extra attributes", () => {
    const output = [
      "worktree /repo.git\nbare",
      "worktree /work/main\nHEAD 1111\nbranch refs/heads/main",
      "worktree /work/feature/refs/heads\nHEAD 2222\nbranch refs/heads/feature/refs/heads",
      "worktree /work/detached\nHEAD 3333\ndetached",
      "worktree /work/gone\nHEAD 4444\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location",
      "",
    ].join("\n\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/repo.git", branch: "Detached HEAD", bare: true },
      { path: "/work/main", branch: "main", bare: false },
      { path: "/work/feature/refs/heads", branch: "feature/refs/heads", bare: false },
      { path: "/work/detached", branch: "Detached HEAD", bare: false },
      { path: "/work/gone", branch: "gone", bare: false },
    ]);
  });
});

describe("activity classification", () => {
  const now = Date.UTC(2026, 9, 1);
  const daysAgo = (days: number) => now - days * 86_400_000;
  const cases = [
    ["idle: clean, generated files, 30+ days", "clean", daysAgo(45), 100, "likely-inactive", "idle"],
    ["dirty wins over age", "dirty", daysAgo(45), 100, "review", "dirty"],
    ["unknown commit time", "clean", null, 100, "review", "no-commit-time"],
    ["old but nothing to reclaim", "clean", daysAgo(45), 0, "review", "nothing-to-reclaim"],
    ["old but status unknown", "unknown", daysAgo(45), 100, "review", "status-unknown"],
    ["past a week, not yet inactive", "clean", daysAgo(12), 100, "review", "aging"],
    ["committed this week", "clean", daysAgo(2), 100, "recent", "active"],
    ["this week, status unknown", "unknown", daysAgo(2), 100, "recent", "active"],
  ] as const;
  for (const [name, status, lastCommitAt, generatedAllocatedBytes, state, cause] of cases) {
    test(name, () => {
      expect(activityFor({ status, lastCommitAt, generatedAllocatedBytes }, now)).toMatchObject({ state, cause });
    });
  }
});
