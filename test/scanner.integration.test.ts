import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupCommand, scanRepository } from "../src/scanner.ts";

const temporaryRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
}

async function makeRepository(): Promise<{ root: string; linked: string }> {
  const root = await mkdtemp(join(tmpdir(), "worktree-diet-"));
  temporaryRoots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "diet@example.test");
  await git(root, "config", "user.name", "Diet Test");
  await writeFile(join(root, "README.md"), "main\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  const linked = join(root, "feature worktree");
  await git(root, "worktree", "add", "-b", "feature", linked);
  return { root, linked };
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("scanRepository", () => {
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
    expect(report.totalBytes).toBe(report.totals.dependencies + report.totals.buildOutput + report.totals.caches + report.totals.sourceOther);
    expect(report.generatedBytes).toBe(12);
    expect(report.worktrees.find((worktree) => worktree.branch === "feature")?.status).toBe("dirty");
    expect(report.worktrees.flatMap((worktree) => worktree.generatedDirectories.map((directory) => directory.name))).toContain("node_modules");
  });

  test("does not count a nested linked worktree while measuring its parent", async () => {
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
    expect(parent?.generatedDirectories.map((directory) => directory.name).sort()).toEqual([".turbo", "dist", "node_modules"]);
  });

  test("does not follow symlinked directories", async () => {
    const { root } = await makeRepository();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "large.bin"), "x".repeat(4096));
    await symlink(outside, join(root, "node_modules"));
    const report = await scanRepository(root);
    expect(report.totals.dependencies).toBe(0);
    expect(report.warnings.some((warning) => warning.path.endsWith("node_modules") && warning.message.includes("symbolic link"))).toBe(true);
  });

  test("returns a useful error for non-Git input", async () => {
    const path = await mkdtemp(join(tmpdir(), "worktree-diet-not-git-"));
    temporaryRoots.push(path);
    await expect(scanRepository(path)).rejects.toThrow("Not a Git repository");
  });

  test("quotes cleanup commands for paths with spaces and quotes", () => {
    expect(cleanupCommand("/tmp/feature worktree/node's modules")).toBe("rm -rf -- '/tmp/feature worktree/node'\"'\"'s modules'");
  });
});
