import { lstat, mkdir, readdir, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";

export type Category = "dependencies" | "buildOutput" | "caches" | "sourceOther";
export type ActivityState = "likely-inactive" | "review" | "recent";

export interface CategorySizes { dependencies: number; buildOutput: number; caches: number; sourceOther: number; }
export interface ScanWarning { path: string; message: string; }
export interface GeneratedDirectory { path: string; name: string; category: Exclude<Category, "sourceOther">; logicalBytes: number; allocatedBytes: number; }
export interface WorktreeRecord {
  repositoryId: string;
  repositoryPath: string;
  branch: string;
  path: string;
  status: "clean" | "dirty" | "unknown";
  lastCommitAt: number | null;
  sizes: CategorySizes;
  allocatedSizes: CategorySizes;
  totalBytes: number;
  allocatedBytes: number;
  generatedBytes: number;
  generatedAllocatedBytes: number;
  activity: { state: ActivityState; reasons: string[] };
  generatedDirectories: GeneratedDirectory[];
  warnings: ScanWarning[];
}
export interface ScanReport {
  roots: string[];
  repositories: { id: string; path: string }[];
  repositoryPath: string;
  worktrees: WorktreeRecord[];
  totals: CategorySizes;
  allocatedTotals: CategorySizes;
  totalBytes: number;
  allocatedBytes: number;
  generatedBytes: number;
  generatedAllocatedBytes: number;
  warnings: ScanWarning[];
  scannedAt: number;
}
export interface TrashResult { moved: { from: string; to: string }[]; warnings: ScanWarning[]; trashPath: string; }

export const INACTIVE_COMMIT_AGE_DAYS = 30;
export const RECENT_COMMIT_AGE_DAYS = 7;
export const MIN_RECLAIMABLE_ALLOCATED_BYTES = 1;
export const DISCOVERY_MAX_DEPTH = 4;
const dependencyDirectories: Record<string, true> = { node_modules: true, ".venv": true, venv: true, ".tox": true, vendor: true };
const buildDirectories: Record<string, true> = { target: true, ".next": true, dist: true, build: true, out: true, coverage: true, ".output": true };
const cacheDirectories: Record<string, true> = { ".turbo": true, ".cache": true, ".parcel-cache": true, ".vite": true, ".eslintcache": true, ".nx": true };

function emptySizes(): CategorySizes { return { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 }; }
function addSizes(left: CategorySizes, right: CategorySizes): CategorySizes {
  return { dependencies: left.dependencies + right.dependencies, buildOutput: left.buildOutput + right.buildOutput, caches: left.caches + right.caches, sourceOther: left.sourceOther + right.sourceOther };
}
function totalSizes(sizes: CategorySizes): number { return sizes.dependencies + sizes.buildOutput + sizes.caches + sizes.sourceOther; }
function generatedTotal(sizes: CategorySizes): number { return sizes.dependencies + sizes.buildOutput + sizes.caches; }
function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Unable to start git" }; }
}
interface DiscoveredWorktree { path: string; branch: string; }
function parseWorktreeList(output: string): DiscoveredWorktree[] {
  const records: DiscoveredWorktree[] = []; let path: string | undefined; let branch: string | undefined;
  for (const line of output.split("\n")) {
    if (line === "") { if (path) records.push({ path, branch: branch ? branch.replace("refs/heads/", "") : "Detached HEAD" }); path = undefined; branch = undefined; }
    else if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line.startsWith("branch ")) branch = line.slice(7);
  }
  if (path) records.push({ path, branch: branch ? branch.replace("refs/heads/", "") : "Detached HEAD" });
  return records;
}
function allocationFor(file: { blocks?: number; size: number }): number { return typeof file.blocks === "number" && file.blocks >= 0 ? file.blocks * 512 : file.size; }
function activityFor(record: Pick<WorktreeRecord, "status" | "lastCommitAt" | "generatedAllocatedBytes">): WorktreeRecord["activity"] {
  const ageDays = record.lastCommitAt === null ? null : Math.max(0, (Date.now() - record.lastCommitAt) / 86_400_000);
  const ageReason = ageDays === null ? "Last commit time is unavailable" : `Last commit was ${Math.floor(ageDays)} days ago`;
  const allocationReason = `${formatByteCount(record.generatedAllocatedBytes)} of generated files can be moved to Trash`;
  if (record.status === "clean" && record.generatedAllocatedBytes >= MIN_RECLAIMABLE_ALLOCATED_BYTES && ageDays !== null && ageDays >= INACTIVE_COMMIT_AGE_DAYS) return { state: "likely-inactive", reasons: [allocationReason, "Git status is clean", ageReason] };
  if (record.status === "dirty") return { state: "review", reasons: [allocationReason, "Git status has uncommitted changes", ageReason] };
  if (ageDays === null || ageDays > RECENT_COMMIT_AGE_DAYS) return { state: "review", reasons: [allocationReason, record.status === "clean" ? "Git status is clean" : "Git status is unavailable", ageReason] };
  return { state: "recent", reasons: [allocationReason, record.status === "clean" ? "Git status is clean" : "Git status is unavailable", ageReason] };
}
interface Measurement { logical: CategorySizes; allocated: CategorySizes; warnings: ScanWarning[]; generatedDirectories: GeneratedDirectory[]; }
async function measureDirectory(root: string, excludedRoots: ReadonlySet<string>, seenFiles: Set<string>): Promise<Measurement> {
  const logical = emptySizes(); const allocated = emptySizes(); const warnings: ScanWarning[] = []; const generatedDirectories: GeneratedDirectory[] = [];
  const visit = async (directory: string, category: Category): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { warnings.push({ path: directory, message: `Could not read directory: ${error instanceof Error ? error.message : "unknown error"}` }); return; }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (category === "sourceOther") warnings.push({ path: entryPath, message: "Skipped symbolic link" });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || excludedRoots.has(entryPath)) continue;
        const entryCategory = category === "sourceOther" ? generatedCategory(entry.name) : category;
        if (category === "sourceOther" && entryCategory !== "sourceOther") {
          const beforeLogical = logical[entryCategory]; const beforeAllocated = allocated[entryCategory];
          await visit(entryPath, entryCategory);
          generatedDirectories.push({ path: entryPath, name: entry.name, category: entryCategory, logicalBytes: logical[entryCategory] - beforeLogical, allocatedBytes: allocated[entryCategory] - beforeAllocated });
        } else await visit(entryPath, entryCategory);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const file = await stat(entryPath); const identity = `${file.dev}:${file.ino}`;
        if (seenFiles.has(identity)) continue;
        seenFiles.add(identity); logical[category] += file.size; allocated[category] += allocationFor(file);
      } catch (error) { warnings.push({ path: entryPath, message: `Could not measure file: ${error instanceof Error ? error.message : "unknown error"}` }); }
    }
  };
  await visit(root, "sourceOther"); return { logical, allocated, warnings, generatedDirectories };
}
async function repositoryIdentity(path: string): Promise<{ id: string; path: string } | undefined> {
  const [commonResult, topLevelResult] = await Promise.all([
    runGit(["rev-parse", "--git-common-dir"], path),
    runGit(["rev-parse", "--show-toplevel"], path),
  ]);
  if (!commonResult.ok || !topLevelResult.ok) return undefined;
  try {
    const common = await realpath(resolve(path, commonResult.output.trim()));
    const topLevel = await realpath(topLevelResult.output.trim());
    return { id: common, path: topLevel };
  } catch { return undefined; }
}
async function inspectWorktree(worktree: DiscoveredWorktree, repository: { id: string; path: string }, allWorktreeRoots: ReadonlySet<string>, seenFiles: Set<string>): Promise<WorktreeRecord> {
  const excludedRoots = new Set(allWorktreeRoots); excludedRoots.delete(worktree.path);
  const measured = await measureDirectory(worktree.path, excludedRoots, seenFiles);
  const statusResult = await runGit(["status", "--porcelain"], worktree.path);
  const status: WorktreeRecord["status"] = statusResult.ok ? (statusResult.output.trim() === "" ? "clean" : "dirty") : "unknown";
  const commitResult = await runGit(["log", "-1", "--format=%ct"], worktree.path);
  const lastCommitAt = commitResult.ok && /^\d+$/.test(commitResult.output.trim()) ? Number(commitResult.output.trim()) * 1000 : null;
  const warnings = [...measured.warnings];
  if (!statusResult.ok) warnings.push({ path: worktree.path, message: `Could not read Git status: ${statusResult.error}` });
  if (!commitResult.ok) warnings.push({ path: worktree.path, message: `Could not read last commit: ${commitResult.error}` });
  const base = { repositoryId: repository.id, repositoryPath: repository.path, ...worktree, status, lastCommitAt, sizes: measured.logical, allocatedSizes: measured.allocated, totalBytes: totalSizes(measured.logical), allocatedBytes: totalSizes(measured.allocated), generatedBytes: generatedTotal(measured.logical), generatedAllocatedBytes: generatedTotal(measured.allocated), generatedDirectories: measured.generatedDirectories, warnings };
  return { ...base, activity: activityFor(base) };
}
async function scanOneRepository(path: string, seenFiles: Set<string>): Promise<{ repository: { id: string; path: string }; worktrees: WorktreeRecord[] } | undefined> {
  const repository = await repositoryIdentity(path); if (!repository) return undefined;
  const discovery = await runGit(["worktree", "list", "--porcelain"], path); if (!discovery.ok) return undefined;
  const worktrees = await Promise.all(parseWorktreeList(discovery.output).map(async (worktree) => ({ ...worktree, path: await realpath(worktree.path) })));
  const displayRepository = { ...repository, path: worktrees[0]?.path ?? repository.path };
  const roots = new Set(worktrees.map((worktree) => worktree.path));
  return { repository: displayRepository, worktrees: await Promise.all(worktrees.map((worktree) => inspectWorktree(worktree, displayRepository, roots, seenFiles))) };
}
async function discoverRepositoryPaths(inputPath: string): Promise<{ paths: string[]; warnings: ScanWarning[] }> {
  const requestedPath = resolve(inputPath); const warnings: ScanWarning[] = [];
  let root: string;
  try { root = await realpath(requestedPath); } catch { warnings.push({ path: requestedPath, message: "Path does not exist" }); return { paths: [], warnings }; }
  const paths: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > DISCOVERY_MAX_DEPTH) return;
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { warnings.push({ path: directory, message: `Could not discover repositories: ${error instanceof Error ? error.message : "unknown error"}` }); return; }
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) { paths.push(directory); return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || generatedCategory(entry.name) !== "sourceOther") continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  if (paths.length === 0 && await repositoryIdentity(root)) paths.push(root);
  return { paths, warnings };
}
export async function scanWorkspace(inputPaths: readonly string[]): Promise<ScanReport> {
  if (inputPaths.length === 0) throw new Error("Provide at least one repository or parent directory path.");
  const roots: string[] = []; const discoveryWarnings: ScanWarning[] = []; const candidates = new Set<string>();
  for (const inputPath of inputPaths) { const discovery = await discoverRepositoryPaths(inputPath); roots.push(resolve(inputPath)); discoveryWarnings.push(...discovery.warnings); for (const path of discovery.paths) candidates.add(path); }
  const seenFiles = new Set<string>(); const repositories = new Map<string, { id: string; path: string }>(); const worktrees = new Map<string, WorktreeRecord>();
  for (const candidate of candidates) {
    const repository = await repositoryIdentity(candidate);
    if (!repository || repositories.has(repository.id)) continue;
    const scanned = await scanOneRepository(candidate, seenFiles);
    if (!scanned) continue;
    repositories.set(scanned.repository.id, scanned.repository);
    for (const worktree of scanned.worktrees) worktrees.set(worktree.path, worktree);
  }
  const records = [...worktrees.values()].sort((left, right) => right.generatedAllocatedBytes - left.generatedAllocatedBytes || left.path.localeCompare(right.path));
  const totals = records.reduce((total, record) => addSizes(total, record.sizes), emptySizes()); const allocatedTotals = records.reduce((total, record) => addSizes(total, record.allocatedSizes), emptySizes());
  return { roots, repositories: [...repositories.values()], repositoryPath: [...repositories.values()][0]?.path ?? "", worktrees: records, totals, allocatedTotals, totalBytes: totalSizes(totals), allocatedBytes: totalSizes(allocatedTotals), generatedBytes: generatedTotal(totals), generatedAllocatedBytes: generatedTotal(allocatedTotals), warnings: [...discoveryWarnings, ...records.flatMap((record) => record.warnings)], scannedAt: Date.now() };
}
export async function scanRepository(inputPath: string): Promise<ScanReport> {
  const report = await scanWorkspace([inputPath]);
  if (report.repositories.length === 0) throw new Error(`Not a Git repository or repository parent: ${resolve(inputPath)}`);
  return report;
}
export async function moveGeneratedDirectories(report: ScanReport, worktreePath: string, options: { trashRoot?: string } = {}): Promise<TrashResult> {
  let canonicalWorktreePath: string;
  try { canonicalWorktreePath = await realpath(resolve(worktreePath)); } catch { throw new Error("That worktree was not returned by the latest scan."); }
  const worktree = report.worktrees.find((record) => record.path === canonicalWorktreePath);
  if (!worktree) throw new Error("That worktree was not returned by the latest scan.");
  const trashRoot = options.trashRoot ?? join(homedir(), ".Trash", "Worktree Diet");
  const destination = join(trashRoot, `${Date.now()}-${crypto.randomUUID()}`); await mkdir(destination, { recursive: true });
  const moved: TrashResult["moved"] = []; const warnings: ScanWarning[] = [];
  for (const directory of worktree.generatedDirectories) {
    try {
      const current = await lstat(directory.path);
      if (!current.isDirectory() || current.isSymbolicLink()) { warnings.push({ path: directory.path, message: "Skipped because it is no longer a real directory" }); continue; }
      if (relative(worktree.path, directory.path).startsWith("..")) { warnings.push({ path: directory.path, message: "Skipped because it is outside the scanned worktree" }); continue; }
      const target = join(destination, `${moved.length}-${basename(directory.path)}`); await rename(directory.path, target); moved.push({ from: directory.path, to: target });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      warnings.push({ path: directory.path, message: code === "EXDEV" ? "Could not move across volumes. Choose a Trash location on the same volume; nothing was deleted." : `Could not move directory: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  }
  return { moved, warnings, trashPath: destination };
}
