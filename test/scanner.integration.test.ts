import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveGeneratedDirectories, scanRepository, scanWorkspace } from "../src/scanner.ts";

const temporaryRoots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
}
async function makeRepository(parent?: string): Promise<{ root: string; linked: string }> {
  const root = parent ? join(parent, `repository-${crypto.randomUUID()}`) : await mkdtemp(join(tmpdir(), "worktree-diet-"));
  if (!parent) temporaryRoots.push(root); else await mkdir(root, { recursive: true });
  await git(root, "init"); await git(root, "config", "user.email", "diet@example.test"); await git(root, "config", "user.name", "Diet Test");
  await writeFile(join(root, "README.md"), "main\n"); await git(root, "add", "README.md"); await git(root, "commit", "-m", "initial");
  const linked = join(root, "feature worktree"); await git(root, "worktree", "add", "-b", "feature", linked); return { root, linked };
}
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("workspace scanner", () => {
  test("discovers linked worktrees, classifies real files, and reports dirty state", async () => {
    const { root, linked } = await makeRepository();
    await mkdir(join(root, "node_modules"), { recursive: true }); await mkdir(join(root, "dist"), { recursive: true }); await mkdir(join(root, ".turbo"), { recursive: true });
    await writeFile(join(root, "node_modules", "package.bin"), "12345"); await writeFile(join(root, "dist", "bundle.js"), "1234"); await writeFile(join(root, ".turbo", "cache.bin"), "123"); await writeFile(join(root, "source.ts"), "12"); await writeFile(join(linked, "changed.txt"), "dirty");
    const report = await scanRepository(root);
    expect(report.worktrees).toHaveLength(2); expect(report.totals.dependencies).toBe(5); expect(report.totals.buildOutput).toBe(4); expect(report.totals.caches).toBe(3); expect(report.totals.sourceOther).toBeGreaterThanOrEqual(7); expect(report.generatedBytes).toBe(12); expect(report.generatedAllocatedBytes).toBeGreaterThan(0); expect(report.worktrees.find((worktree) => worktree.branch === "feature")?.status).toBe("dirty"); expect(report.worktrees.flatMap((worktree) => worktree.generatedDirectories.map((directory) => directory.name))).toContain("node_modules");
  });
  test("discovers repositories from multiple parents and deduplicates shared worktrees", async () => {
    const parent = await mkdtemp(join(tmpdir(), "worktree-diet-parent-")); temporaryRoots.push(parent); const first = await makeRepository(parent); const second = await makeRepository(parent);
    const report = await scanWorkspace([parent, first.root, second.linked]);
    expect(report.repositories).toHaveLength(2); expect(report.worktrees).toHaveLength(4); expect(new Set(report.worktrees.map((worktree) => worktree.path)).size).toBe(4);
  });
  test("prefers repositories inside a parent directory even when that parent sits in another repository", async () => {
    const outer = await mkdtemp(join(tmpdir(), "worktree-diet-outer-")); temporaryRoots.push(outer); await git(outer, "init"); const parent = join(outer, "repositories"); await mkdir(parent); const nested = await makeRepository(parent);
    const report = await scanWorkspace([parent]);
    expect(report.repositories).toHaveLength(1); expect(report.repositories[0]?.path).toBe(await realpath(nested.root)); expect(report.worktrees).toHaveLength(2);
  });
  test("does not count nested linked worktrees while measuring their parent", async () => {
    const { root, linked } = await makeRepository(); await writeFile(join(root, "parent.txt"), "parent"); await writeFile(join(linked, "linked.txt"), "linked");
    const report = await scanRepository(root); const canonicalRoot = await realpath(root); const parent = report.worktrees.find((worktree) => worktree.path === canonicalRoot);
    expect(parent?.sizes.sourceOther).toBe("main\nparent".length); expect(report.totals.sourceOther).toBeGreaterThan(parent?.sizes.sourceOther ?? 0);
  });
  test("suggests only outermost generated directories", async () => {
    const { root } = await makeRepository(); await mkdir(join(root, "node_modules", "package", "nested"), { recursive: true }); await mkdir(join(root, "dist", "assets", "nested"), { recursive: true }); await mkdir(join(root, ".turbo", "cache", "nested"), { recursive: true }); await writeFile(join(root, "node_modules", "package", "nested", "index.js"), "dependency"); await writeFile(join(root, "dist", "assets", "nested", "bundle.js"), "build"); await writeFile(join(root, ".turbo", "cache", "nested", "entry"), "cache");
    const report = await scanRepository(root); const canonicalRoot = await realpath(root); const parent = report.worktrees.find((worktree) => worktree.path === canonicalRoot); expect(parent?.generatedDirectories.map((directory) => directory.name).sort()).toEqual([".turbo", "dist", "node_modules"]);
  });
  test("deduplicates hardlinked generated files when inode data is available", async () => {
    const { root } = await makeRepository(); await mkdir(join(root, "node_modules", "a"), { recursive: true }); await mkdir(join(root, "dist"), { recursive: true }); const original = join(root, "node_modules", "a", "package.bin"); await writeFile(original, "x".repeat(2048)); await link(original, join(root, "dist", "package-copy.bin"));
    const report = await scanRepository(root); expect(report.generatedBytes).toBe(2048); expect(report.generatedAllocatedBytes).toBeGreaterThan(0);
  });
  test("does not follow symlinked directories", async () => {
    const { root } = await makeRepository(); const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "large.bin"), "x".repeat(4096)); await symlink(outside, join(root, "node_modules")); const report = await scanRepository(root); expect(report.totals.dependencies).toBe(0); expect(report.warnings.some((warning) => warning.path.endsWith("node_modules") && warning.message.includes("symbolic link"))).toBe(true);
  });
  test("explains heuristic state with explicit Git and age evidence", async () => {
    const { root, linked } = await makeRepository(); await mkdir(join(linked, "dist")); await writeFile(join(linked, "dist", "bundle"), "artifact"); await git(linked, "add", "dist"); await git(linked, "commit", "-m", "generated fixture"); const report = await scanRepository(root); const canonicalLinked = await realpath(linked); const record = report.worktrees.find((worktree) => worktree.path === canonicalLinked); expect(record?.activity.state).toBe("recent"); expect(record?.activity.reasons.some((reason) => reason.includes("Git status is clean"))).toBe(true); expect(record?.activity.reasons.some((reason) => reason.includes("Last commit was"))).toBe(true);
  });
  test("moves only scanned generated directories to a temporary Trash root", async () => {
    const { root } = await makeRepository(); const trash = await mkdtemp(join(tmpdir(), "worktree-diet-trash-")); temporaryRoots.push(trash); await mkdir(join(root, "dist")); await writeFile(join(root, "dist", "bundle"), "artifact"); await writeFile(join(root, "keep.txt"), "source"); const report = await scanRepository(root); const result = await moveGeneratedDirectories(report, root, { trashRoot: trash }); expect(result.moved).toHaveLength(1); expect(await Bun.file(join(root, "keep.txt")).text()).toBe("source"); expect(await Bun.file(join(root, "dist")).exists()).toBe(false); expect(await Bun.file(join(result.moved[0]?.to ?? "", "bundle")).text()).toBe("artifact");
  });
  test("rejects an unscanned worktree path at the trash boundary", async () => {
    const { root } = await makeRepository(); const outside = await mkdtemp(join(tmpdir(), "worktree-diet-outside-")); temporaryRoots.push(outside); await mkdir(join(root, "dist")); await writeFile(join(root, "dist", "bundle"), "artifact"); const report = await scanRepository(root); await expect(moveGeneratedDirectories(report, outside, { trashRoot: join(outside, "trash") })).rejects.toThrow("latest scan"); expect(await Bun.file(join(root, "dist", "bundle")).exists()).toBe(true);
  });
  test("returns a useful error for non-Git input", async () => { const path = await mkdtemp(join(tmpdir(), "worktree-diet-not-git-")); temporaryRoots.push(path); await expect(scanRepository(path)).rejects.toThrow("Not a Git repository"); });
});
