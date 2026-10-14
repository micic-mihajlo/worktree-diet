import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Category = "dependencies" | "buildOutput" | "caches" | "sourceOther";
export type GeneratedCategory = Exclude<Category, "sourceOther">;
export type ActivityState = "likely-inactive" | "review" | "recent";
/** Why a worktree got its state, so the UI can explain it without re-deriving the rules. */
export type ActivityCause =
  | "idle" // likely-inactive: clean, has generated files, and no commit for INACTIVE_COMMIT_AGE_DAYS
  | "dirty" // review: uncommitted changes
  | "no-commit-time" // review: the last commit time could not be read
  | "nothing-to-reclaim" // review: older than a week but has no generated files
  | "status-unknown" // review: older than a week but Git status could not be read
  | "aging" // review: clean, older than a week, but not yet inactive
  | "active"; // recent: committed to within RECENT_COMMIT_AGE_DAYS

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
  category: GeneratedCategory;
  logicalBytes: number;
  allocatedBytes: number;
}
export interface Activity {
  state: ActivityState;
  cause: ActivityCause;
  reasons: string[];
}
export interface Repository {
  id: string;
  path: string;
}
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
  activity: Activity;
  generatedDirectories: GeneratedDirectory[];
  warnings: ScanWarning[];
}
export interface ScanReport {
  roots: string[];
  repositories: Repository[];
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
export interface TrashResult {
  moved: { from: string; to: string }[];
  warnings: ScanWarning[];
  trashPath: string;
}

export const INACTIVE_COMMIT_AGE_DAYS = 30;
export const RECENT_COMMIT_AGE_DAYS = 7;
export const MIN_RECLAIMABLE_ALLOCATED_BYTES = 1;
export const DISCOVERY_MAX_DEPTH = 4;
/** Filesystem calls in flight at once. Throughput plateaus around 32–64 and drops past that from contention. */
const FILESYSTEM_CONCURRENCY = 32;
/** Git processes running at once. */
const GIT_CONCURRENCY = 8;
const DAY_MS = 86_400_000;

const generatedDirectoryNames: Record<string, GeneratedCategory> = {
  node_modules: "dependencies",
  ".venv": "dependencies",
  venv: "dependencies",
  ".tox": "dependencies",
  vendor: "dependencies",
  target: "buildOutput",
  ".next": "buildOutput",
  dist: "buildOutput",
  build: "buildOutput",
  out: "buildOutput",
  coverage: "buildOutput",
  ".output": "buildOutput",
  ".turbo": "caches",
  ".cache": "caches",
  ".parcel-cache": "caches",
  ".vite": "caches",
  ".eslintcache": "caches",
  ".nx": "caches",
};

export function generatedCategory(directoryName: string): Category {
  return Object.hasOwn(generatedDirectoryNames, directoryName)
    ? (generatedDirectoryNames[directoryName] ?? "sourceOther")
    : "sourceOther";
}

function emptySizes(): CategorySizes {
  return { dependencies: 0, buildOutput: 0, caches: 0, sourceOther: 0 };
}
function addSizes(left: CategorySizes, right: CategorySizes): CategorySizes {
  return {
    dependencies: left.dependencies + right.dependencies,
    buildOutput: left.buildOutput + right.buildOutput,
    caches: left.caches + right.caches,
    sourceOther: left.sourceOther + right.sourceOther,
  };
}
function totalSizes(sizes: CategorySizes): number {
  return sizes.dependencies + sizes.buildOutput + sizes.caches + sizes.sourceOther;
}
function generatedTotal(sizes: CategorySizes): number {
  return sizes.dependencies + sizes.buildOutput + sizes.caches;
}
function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
/** Allocated size prefers block accounting, which reflects what deleting the file would free. */
function allocationFor(file: Pick<Stats, "blocks" | "size">): number {
  return typeof file.blocks === "number" && file.blocks >= 0 ? file.blocks * 512 : file.size;
}

/** Runs at most `limit` tasks at once. Only wrap leaf operations: a task that awaits more limited work can deadlock. */
function concurrencyLimit(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
type Limit = ReturnType<typeof concurrencyLimit>;

type GitResult = { ok: true; output: string } | { ok: false; error: string };
async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return code === 0 ? { ok: true, output } : { ok: false, error: error.trim() || `git exited with ${code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to start git" };
  }
}

interface ListedWorktree {
  path: string;
  branch: string;
  bare: boolean;
}
export function parseWorktreeList(output: string): ListedWorktree[] {
  const records: ListedWorktree[] = [];
  for (const block of output.split(/\n\n+/)) {
    let path: string | undefined;
    let branch = "Detached HEAD";
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "bare") bare = true;
    }
    if (path) records.push({ path, branch, bare });
  }
  return records;
}

export function activityFor(
  record: Pick<WorktreeRecord, "status" | "lastCommitAt" | "generatedAllocatedBytes">,
  now = Date.now(),
): Activity {
  const ageDays = record.lastCommitAt === null ? null : Math.max(0, (now - record.lastCommitAt) / DAY_MS);
  const hasGenerated = record.generatedAllocatedBytes >= MIN_RECLAIMABLE_ALLOCATED_BYTES;
  const reasons = [
    `${formatByteCount(record.generatedAllocatedBytes)} of generated files can be moved to Trash`,
    record.status === "clean"
      ? "Git status is clean"
      : record.status === "dirty"
        ? "Git status has uncommitted changes"
        : "Git status is unavailable",
    ageDays === null ? "Last commit time is unavailable" : `Last commit was ${Math.floor(ageDays)} days ago`,
  ];
  const activity = (state: ActivityState, cause: ActivityCause): Activity => ({ state, cause, reasons });

  if (record.status === "clean" && hasGenerated && ageDays !== null && ageDays >= INACTIVE_COMMIT_AGE_DAYS)
    return activity("likely-inactive", "idle");
  if (record.status === "dirty") return activity("review", "dirty");
  if (ageDays === null) return activity("review", "no-commit-time");
  if (ageDays > RECENT_COMMIT_AGE_DAYS) {
    if (!hasGenerated) return activity("review", "nothing-to-reclaim");
    if (record.status !== "clean") return activity("review", "status-unknown");
    return activity("review", "aging");
  }
  return activity("recent", "active");
}

/** Where a measured file's bytes are added: its worktree, and its generated directory if it is inside one. */
interface Tally {
  logical: CategorySizes;
  allocated: CategorySizes;
}
interface Claim {
  path: string;
  category: Category;
  logical: number;
  allocated: number;
  tally: Tally;
  directory: GeneratedDirectory | undefined;
}
function addToTally(claim: Omit<Claim, "path">): void {
  claim.tally.logical[claim.category] += claim.logical;
  claim.tally.allocated[claim.category] += claim.allocated;
  if (claim.directory) {
    claim.directory.logicalBytes += claim.logical;
    claim.directory.allocatedBytes += claim.allocated;
  }
}

/**
 * Hardlinked files (pnpm stores, shared caches) are counted once per scan, for the alphabetically first
 * path that links to them. Deciding after traversal keeps sizes identical between scans however the
 * parallel walk happens to be ordered. Every directory is walked by exactly one worktree (each walk
 * excludes all other worktree roots), so a file with a single link is reached once and skips this.
 */
class HardlinkLedger {
  readonly #claims = new Map<string, Claim>();
  claim(file: Stats, claim: Claim): void {
    const identity = `${file.dev}:${file.ino}`;
    const current = this.#claims.get(identity);
    if (!current || claim.path < current.path) this.#claims.set(identity, claim);
  }
  settle(): void {
    for (const claim of this.#claims.values()) addToTally(claim);
  }
}

interface Measurement extends Tally {
  generatedDirectories: GeneratedDirectory[];
  warnings: ScanWarning[];
}
async function measureWorktree(
  root: string,
  excludedRoots: ReadonlySet<string>,
  ledger: HardlinkLedger,
  io: Limit,
): Promise<Measurement> {
  const tally: Tally = { logical: emptySizes(), allocated: emptySizes() };
  const generatedDirectories: GeneratedDirectory[] = [];
  const warnings: ScanWarning[] = [];

  const visit = async (directory: string, category: Category, generated?: GeneratedDirectory): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await io(() => readdir(directory, { withFileTypes: true }));
    } catch (error) {
      warnings.push({ path: directory, message: `Could not read directory: ${errorMessage(error)}` });
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          // Links inside generated folders are routine (node_modules/.bin); only note ones in source.
          if (category === "sourceOther") warnings.push({ path, message: "Skipped symbolic link" });
          return;
        }
        if (entry.isDirectory()) {
          if (entry.name === ".git" || excludedRoots.has(path)) return;
          let childCategory = category === "sourceOther" ? generatedCategory(entry.name) : category;
          const nested =
            category === "sourceOther" && childCategory !== "sourceOther"
              ? [...excludedRoots].find((root) => isInside(path, root))
              : undefined;
          if (nested) {
            // Moving this folder would carry another worktree, and its uncommitted work, into Trash.
            warnings.push({
              path,
              message: `Not treated as generated because it contains the worktree ${nested}`,
            });
            childCategory = "sourceOther";
          }
          if (category === "sourceOther" && childCategory !== "sourceOther") {
            // Only the outermost generated folder is listed; everything below it belongs to it.
            const folder: GeneratedDirectory = {
              path,
              name: entry.name,
              category: childCategory,
              logicalBytes: 0,
              allocatedBytes: 0,
            };
            generatedDirectories.push(folder);
            return visit(path, childCategory, folder);
          }
          return visit(path, childCategory, generated);
        }
        if (!entry.isFile()) return;
        try {
          const file = await io(() => lstat(path));
          const claim: Claim = {
            path,
            category,
            logical: file.size,
            allocated: allocationFor(file),
            tally,
            directory: generated,
          };
          if (file.nlink > 1) ledger.claim(file, claim);
          else addToTally(claim);
        } catch (error) {
          warnings.push({ path, message: `Could not measure file: ${errorMessage(error)}` });
        }
      }),
    );
  };

  await visit(root, "sourceOther");
  // The walk is parallel, so order its results by path to keep reports stable.
  generatedDirectories.sort((left, right) => left.path.localeCompare(right.path));
  warnings.sort((left, right) => left.path.localeCompare(right.path));
  return { ...tally, generatedDirectories, warnings };
}

async function repositoryIdentity(path: string, git: Limit): Promise<Repository | { error: string }> {
  const [common, topLevel] = await Promise.all([
    git(() => runGit(["rev-parse", "--git-common-dir"], path)),
    git(() => runGit(["rev-parse", "--show-toplevel"], path)),
  ]);
  if (!common.ok) return { error: common.error };
  if (!topLevel.ok) return { error: topLevel.error };
  try {
    return { id: await realpath(resolve(path, common.output.trim())), path: await realpath(topLevel.output.trim()) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function discoverRepositoryPaths(
  inputPath: string,
  io: Limit,
  git: Limit,
): Promise<{ paths: string[]; warnings: ScanWarning[] }> {
  const requestedPath = resolve(inputPath);
  const warnings: ScanWarning[] = [];
  let root: string;
  try {
    root = await realpath(requestedPath);
  } catch {
    return { paths: [], warnings: [{ path: requestedPath, message: "Path does not exist" }] };
  }
  const paths: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > DISCOVERY_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await io(() => readdir(directory, { withFileTypes: true }));
    } catch (error) {
      warnings.push({ path: directory, message: `Could not discover repositories: ${errorMessage(error)}` });
      return;
    }
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      paths.push(directory);
      return;
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            entry.name !== ".git" &&
            generatedCategory(entry.name) === "sourceOther",
        )
        .map((entry) => visit(join(directory, entry.name), depth + 1)),
    );
  };
  await visit(root, 0);
  // A path inside a repository (rather than a parent of repositories) still counts.
  if (paths.length === 0 && "id" in (await repositoryIdentity(root, git))) paths.push(root);
  return { paths: paths.sort(), warnings };
}

interface ListedRepository {
  repository: Repository;
  worktrees: { path: string; branch: string }[];
  warnings: ScanWarning[];
}

/** Lists a repository's worktrees; folders that no longer exist become warnings. */
async function listRepository(candidate: string, identity: Repository, git: Limit): Promise<ListedRepository> {
  const listing = await git(() => runGit(["worktree", "list", "--porcelain"], candidate));
  if (!listing.ok)
    return {
      repository: identity,
      worktrees: [],
      warnings: [{ path: candidate, message: `Could not list worktrees: ${listing.error}` }],
    };
  const listed = parseWorktreeList(listing.output).filter((worktree) => !worktree.bare);
  const resolved = await Promise.allSettled(listed.map((worktree) => realpath(worktree.path)));
  const worktrees: ListedRepository["worktrees"] = [];
  const warnings: ScanWarning[] = [];
  for (const [index, result] of resolved.entries()) {
    const worktree = listed[index];
    if (!worktree) continue;
    if (result.status === "fulfilled") worktrees.push({ path: result.value, branch: worktree.branch });
    else
      warnings.push({
        path: worktree.path,
        message: "Worktree folder is missing; `git worktree prune` removes the stale entry",
      });
  }
  // Git lists the main worktree first, so it names the repository.
  return { repository: { ...identity, path: worktrees[0]?.path ?? identity.path }, worktrees, warnings };
}

interface PendingWorktree {
  repository: Repository;
  path: string;
  branch: string;
  measurement: Promise<Measurement>;
  status: Promise<GitResult>;
  lastCommit: Promise<GitResult>;
}

async function finishWorktree(pending: PendingWorktree): Promise<WorktreeRecord> {
  const [measured, status, lastCommit] = await Promise.all([pending.measurement, pending.status, pending.lastCommit]);
  const warnings = [...measured.warnings];
  if (!status.ok) warnings.push({ path: pending.path, message: `Could not read Git status: ${status.error}` });
  if (!lastCommit.ok) warnings.push({ path: pending.path, message: `Could not read last commit: ${lastCommit.error}` });
  const commitSeconds = lastCommit.ok ? lastCommit.output.trim() : "";
  const base = {
    repositoryId: pending.repository.id,
    repositoryPath: pending.repository.path,
    branch: pending.branch,
    path: pending.path,
    status: status.ok ? (status.output.trim() === "" ? ("clean" as const) : ("dirty" as const)) : ("unknown" as const),
    lastCommitAt: /^\d+$/.test(commitSeconds) ? Number(commitSeconds) * 1000 : null,
    sizes: measured.logical,
    allocatedSizes: measured.allocated,
    totalBytes: totalSizes(measured.logical),
    allocatedBytes: totalSizes(measured.allocated),
    generatedBytes: generatedTotal(measured.logical),
    generatedAllocatedBytes: generatedTotal(measured.allocated),
    generatedDirectories: measured.generatedDirectories,
    warnings,
  };
  return { ...base, activity: activityFor(base) };
}

export async function scanWorkspace(inputPaths: readonly string[]): Promise<ScanReport> {
  if (inputPaths.length === 0) throw new Error("Provide at least one repository or parent directory path.");
  const io = concurrencyLimit(FILESYSTEM_CONCURRENCY);
  const git = concurrencyLimit(GIT_CONCURRENCY);
  const roots = inputPaths.map((path) => resolve(path));

  const discoveries = await Promise.all(roots.map((root) => discoverRepositoryPaths(root, io, git)));
  const warnings = discoveries.flatMap((discovery) => discovery.warnings);
  const candidates = [...new Set(discoveries.flatMap((discovery) => discovery.paths))].sort();

  // Several candidates can be worktrees of one repository; scan each repository once.
  const identities = await Promise.all(candidates.map((candidate) => repositoryIdentity(candidate, git)));
  const unique = new Map<string, { candidate: string; identity: Repository }>();
  for (const [index, identity] of identities.entries()) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if ("error" in identity)
      warnings.push({ path: candidate, message: `Could not read this repository: ${identity.error}` });
    else if (!unique.has(identity.id)) unique.set(identity.id, { candidate, identity });
  }

  const listed = await Promise.all(
    [...unique.values()].map(({ candidate, identity }) => listRepository(candidate, identity, git)),
  );
  // Every walk skips every other worktree root, from any repository, so each directory is measured once
  // and a worktree nested inside another (or inside another repository) is never counted twice.
  const allRoots = new Set(listed.flatMap((repository) => repository.worktrees.map((worktree) => worktree.path)));
  const ledger = new HardlinkLedger();
  const pending: PendingWorktree[] = listed.flatMap(({ repository, worktrees }) =>
    worktrees.map((worktree) => {
      const excluded = new Set(allRoots);
      excluded.delete(worktree.path);
      return {
        repository,
        ...worktree,
        measurement: measureWorktree(worktree.path, excluded, ledger, io),
        status: git(() => runGit(["status", "--porcelain"], worktree.path)),
        lastCommit: git(() => runGit(["log", "-1", "--format=%ct"], worktree.path)),
      };
    }),
  );
  // Every file must be seen before hardlinks are settled, so wait for all measurements first.
  await Promise.all(pending.map((worktree) => worktree.measurement));
  ledger.settle();

  const records = new Map<string, WorktreeRecord>();
  for (const record of await Promise.all(pending.map(finishWorktree))) records.set(record.path, record);
  return buildReport(
    roots,
    listed.map((repository) => repository.repository).sort((left, right) => left.path.localeCompare(right.path)),
    [...records.values()],
    [...warnings, ...listed.flatMap((repository) => repository.warnings)],
  );
}

export function buildReport(
  roots: string[],
  repositories: Repository[],
  worktrees: WorktreeRecord[],
  scanWarnings: ScanWarning[] = [],
): ScanReport {
  const records = [...worktrees].sort(
    (left, right) =>
      right.generatedAllocatedBytes - left.generatedAllocatedBytes || left.path.localeCompare(right.path),
  );
  const totals = records.reduce((total, record) => addSizes(total, record.sizes), emptySizes());
  const allocatedTotals = records.reduce((total, record) => addSizes(total, record.allocatedSizes), emptySizes());
  return {
    roots,
    repositories,
    worktrees: records,
    totals,
    allocatedTotals,
    totalBytes: totalSizes(totals),
    allocatedBytes: totalSizes(allocatedTotals),
    generatedBytes: generatedTotal(totals),
    generatedAllocatedBytes: generatedTotal(allocatedTotals),
    warnings: [...scanWarnings, ...records.flatMap((record) => record.warnings)],
    scannedAt: Date.now(),
  };
}

export async function scanRepository(inputPath: string): Promise<ScanReport> {
  const report = await scanWorkspace([inputPath]);
  if (report.repositories.length === 0)
    throw new Error(`Not a Git repository or repository parent: ${resolve(inputPath)}`);
  return report;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * The folders a move acts on: every generated folder the scan found, or, when the user confirmed a
 * specific list, only those that are also still in the scan. So a folder that appeared after the
 * confirmation is never moved unseen, and a path the scan didn't produce never is either.
 */
export function foldersToMove(
  worktree: WorktreeRecord,
  confirmed?: readonly string[],
): { folders: GeneratedDirectory[]; warnings: ScanWarning[] } {
  if (!confirmed) return { folders: worktree.generatedDirectories, warnings: [] };
  const wanted = new Set(confirmed);
  const scanned = new Set(worktree.generatedDirectories.map((directory) => directory.path));
  return {
    folders: worktree.generatedDirectories.filter((directory) => wanted.has(directory.path)),
    warnings: confirmed
      .filter((path) => !scanned.has(path))
      .map((path) => ({ path, message: "Skipped because it is no longer in the latest scan" })),
  };
}

/**
 * Moves the generated folders the latest scan found in one worktree into a fresh Trash folder.
 * Paths come only from the report, and each is re-checked first: inside the worktree, holding no other
 * worktree, still a real directory, and still at the same canonical path, so a parent swapped for a
 * symlink since the scan can't redirect the move elsewhere.
 */
export async function moveGeneratedDirectories(
  report: ScanReport,
  worktreePath: string,
  options: { trashRoot?: string; confirmed?: readonly string[] } = {},
): Promise<TrashResult> {
  const notScanned = new Error("That worktree was not returned by the latest scan.");
  let canonicalWorktreePath: string;
  try {
    canonicalWorktreePath = await realpath(resolve(worktreePath));
  } catch {
    throw notScanned;
  }
  const worktree = report.worktrees.find((record) => record.path === canonicalWorktreePath);
  if (!worktree) throw notScanned;

  const trashRoot = options.trashRoot ?? join(homedir(), ".Trash", "Worktree Diet");
  const trashPath = join(trashRoot, `${Date.now()}-${crypto.randomUUID()}`);
  let trashReady = false;
  const moved: TrashResult["moved"] = [];
  const warnings: ScanWarning[] = [];
  const skip = (path: string, message: string) => warnings.push({ path, message });
  const { folders, warnings: unavailable } = foldersToMove(worktree, options.confirmed);
  warnings.push(...unavailable);

  for (const directory of folders) {
    try {
      if (!isInside(worktree.path, directory.path)) {
        skip(directory.path, "Skipped because it is outside the scanned worktree");
        continue;
      }
      const nested = report.worktrees.find((other) => isInside(directory.path, other.path));
      if (nested) {
        skip(directory.path, `Skipped because it contains the worktree ${nested.path}`);
        continue;
      }
      const current = await lstat(directory.path);
      if (!current.isDirectory()) {
        skip(directory.path, "Skipped because it is no longer a real directory");
        continue;
      }
      if ((await realpath(directory.path)) !== directory.path) {
        skip(directory.path, "Skipped because its location changed since the scan");
        continue;
      }
      if (!trashReady) {
        await mkdir(trashPath, { recursive: true });
        trashReady = true;
      }
      const target = join(trashPath, `${moved.length}-${basename(directory.path)}`);
      await rename(directory.path, target);
      moved.push({ from: directory.path, to: target });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      skip(
        directory.path,
        code === "EXDEV"
          ? "Skipped because it is on a different volume from the Trash, so moving would mean copying; nothing was changed"
          : `Could not move directory: ${errorMessage(error)}`,
      );
    }
  }
  return { moved, warnings, trashPath };
}
