import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";

export type Category = "dependencies" | "buildOutput" | "caches" | "sourceOther";

export interface CategorySizes {
  dependencies: number;
  buildOutput: number;
  caches: number;
  sourceOther: number;
}

export interface ScanWarning {
  path: string;
  message: string;
}

export interface GeneratedDirectory {
  path: string;
  name: string;
  category: Exclude<Category, "sourceOther">;
}

export interface WorktreeRecord {
  branch: string;
  path: string;
  status: "clean" | "dirty" | "unknown";
  lastCommitAt: number | null;
  sizes: CategorySizes;
  totalBytes: number;
  generatedBytes: number;
  generatedDirectories: GeneratedDirectory[];
  warnings: ScanWarning[];
}

export interface ScanReport {
  repositoryPath: string;
  worktrees: WorktreeRecord[];
  totals: CategorySizes;
  totalBytes: number;
  generatedBytes: number;
  warnings: ScanWarning[];
  scannedAt: number;
}

const dependencyDirectories: Record<string, true> = { node_modules: true, ".venv": true, venv: true, ".tox": true, vendor: true };
const buildDirectories: Record<string, true> = { target: true, ".next": true, dist: true, build: true, out: true, coverage: true, ".output": true };
const cacheDirectories: Record<string, true> = { ".turbo": true, ".cache": true, ".parcel-cache": true, ".vite": true, ".eslintcache": true, ".nx": true };

function emptySizes(): CategorySizes {
  return { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 };
}

function generatedCategory(directoryName: string): Category {
  if (dependencyDirectories[directoryName]) return "dependencies";
  if (buildDirectories[directoryName]) return "buildOutput";
  if (cacheDirectories[directoryName]) return "caches";
  return "sourceOther";
}


async function runGit(args: string[], cwd: string): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return code === 0 ? { ok: true, output } : { ok: false, error: error.trim() || `git exited with ${code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to start git" };
  }
}

interface DiscoveredWorktree { path: string; branch: string; }

function parseWorktreeList(output: string): DiscoveredWorktree[] {
  const records: DiscoveredWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  for (const line of output.split("\n")) {
    if (line === "") {
      if (path) records.push({ path, branch: branch ? branch.replace("refs/heads/", "") : "Detached HEAD" });
      path = undefined;
      branch = undefined;
    } else if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
  }
  if (path) records.push({ path, branch: branch ? branch.replace("refs/heads/", "") : "Detached HEAD" });
  return records;
}

async function measureDirectory(root: string, excludedRoots: ReadonlySet<string>): Promise<{ sizes: CategorySizes; warnings: ScanWarning[]; generatedDirectories: GeneratedDirectory[] }> {
  const sizes = emptySizes();
  const warnings: ScanWarning[] = [];
  const generatedDirectories: GeneratedDirectory[] = [];
  const visit = async (directory: string, category: Category): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push({ path: directory, message: `Could not read directory: ${error instanceof Error ? error.message : "unknown error"}` });
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push({ path: entryPath, message: "Skipped symbolic link" });
        return;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || excludedRoots.has(entryPath)) return;
        const entryCategory = category === "sourceOther" ? generatedCategory(entry.name) : category;
        if (category === "sourceOther" && entryCategory !== "sourceOther") {
          generatedDirectories.push({ path: entryPath, name: entry.name, category: entryCategory });
        }
        await visit(entryPath, entryCategory);
        return;
      }
      if (!entry.isFile()) return;
      try {
        const file = await stat(entryPath);
        sizes[category] += file.size;
      } catch (error) {
        warnings.push({ path: entryPath, message: `Could not measure file: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }));
  };
  await visit(root, "sourceOther");
  return { sizes, warnings, generatedDirectories };
}

async function inspectWorktree(worktree: DiscoveredWorktree, allWorktreeRoots: ReadonlySet<string>): Promise<WorktreeRecord> {
  const warnings: ScanWarning[] = [];
  const excludedRoots = new Set(allWorktreeRoots);
  excludedRoots.delete(worktree.path);
  const measured = await measureDirectory(worktree.path, excludedRoots);
  warnings.push(...measured.warnings);
  const statusResult = await runGit(["status", "--porcelain"], worktree.path);
  const status = statusResult.ok ? (statusResult.output.trim() === "" ? "clean" : "dirty") : "unknown";
  if (!statusResult.ok) warnings.push({ path: worktree.path, message: `Could not read Git status: ${statusResult.error}` });
  const commitResult = await runGit(["log", "-1", "--format=%ct"], worktree.path);
  const lastCommitAt = commitResult.ok && /^\d+$/.test(commitResult.output.trim()) ? Number(commitResult.output.trim()) * 1000 : null;
  if (!commitResult.ok) warnings.push({ path: worktree.path, message: `Could not read last commit: ${commitResult.error}` });
  const totalBytes = Object.values(measured.sizes).reduce((total, size) => total + size, 0);
  return { ...worktree, status, lastCommitAt, sizes: measured.sizes, totalBytes, generatedBytes: measured.sizes.dependencies + measured.sizes.buildOutput + measured.sizes.caches, generatedDirectories: measured.generatedDirectories, warnings };
}

export async function scanRepository(inputPath: string): Promise<ScanReport> {
  const requestedPath = resolve(inputPath);
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(requestedPath);
  } catch {
    throw new Error(`Repository path does not exist: ${requestedPath}`);
  }
  const discovery = await runGit(["worktree", "list", "--porcelain"], repositoryPath);
  if (!discovery.ok) throw new Error(`Not a Git repository: ${repositoryPath}. ${discovery.error}`);
  const worktrees = parseWorktreeList(discovery.output).map((worktree) => ({ ...worktree, path: resolve(worktree.path) }));
  if (worktrees.length === 0) throw new Error(`Git returned no worktrees for: ${repositoryPath}`);
  const worktreeRoots = new Set(worktrees.map((worktree) => worktree.path));
  const inspected = await Promise.all(worktrees.map((worktree) => inspectWorktree(worktree, worktreeRoots)));
  const totals = inspected.reduce<CategorySizes>((total, record) => ({
    dependencies: total.dependencies + record.sizes.dependencies,
    buildOutput: total.buildOutput + record.sizes.buildOutput,
    caches: total.caches + record.sizes.caches,
    sourceOther: total.sourceOther + record.sizes.sourceOther,
  }), emptySizes());
  return {
    repositoryPath,
    worktrees: inspected,
    totals,
    totalBytes: Object.values(totals).reduce((total, size) => total + size, 0),
    generatedBytes: totals.dependencies + totals.buildOutput + totals.caches,
    warnings: inspected.flatMap((record) => record.warnings),
    scannedAt: Date.now(),
  };
}

export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\"'\"'")}'`;
}

export function cleanupCommand(path: string): string {
  return `rm -rf -- ${shellQuote(path)}`;
}
