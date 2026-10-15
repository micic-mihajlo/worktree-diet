import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoots: string[] = [];

/** Removes every directory created by `temporaryDirectory` and `makeRepository`; call from `afterEach`. */
export async function cleanTemporaryRoots(): Promise<void> {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function temporaryDirectory(prefix = "worktree-diet-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

export async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
}

/** A repository with one commit and a linked worktree at `<root>/feature worktree`. */
export async function makeRepository(parent?: string): Promise<{ root: string; linked: string }> {
  const root = parent ? join(parent, `repository-${crypto.randomUUID()}`) : await temporaryDirectory();
  if (parent) await mkdir(root, { recursive: true });
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
