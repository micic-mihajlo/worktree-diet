import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDemoReport } from "../src/demo.ts";
import { MUTATION_TOKEN_HEADER, type ReportResponse } from "../src/protocol.ts";
import type { ScanReport, TrashResult } from "../src/scanner.ts";
import { diskWorkspace, HttpError, type LocalServer, startServer } from "../src/server.ts";
import { cleanTemporaryRoots, makeRepository, temporaryDirectory } from "./helpers.ts";

let server: LocalServer | undefined;
afterEach(async () => {
  server?.stop();
  server = undefined;
  await cleanTemporaryRoots();
});

const getReport = async (url: string): Promise<ReportResponse> => (await fetch(`${url}/api/report`)).json();

describe("local server", () => {
  test("serves the bundled page and every asset it references", async () => {
    server = startServer([], { demo: createDemoReport() });
    const html = await (await fetch(server.url)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1] ?? "");
    expect(assets.filter((asset) => /\.(js|css)$/.test(asset))).toHaveLength(2);
    for (const asset of assets) expect((await fetch(`${server.url}${asset}`)).status).toBe(200);
  });

  test("refuses API requests addressed to another host, to block DNS rebinding", async () => {
    server = startServer([], { demo: createDemoReport() });
    const port = new URL(server.url).port;
    expect((await fetch(`${server.url}/api/report`, { headers: { host: `localhost:${port}` } })).status).toBe(200);
    const rebound = await fetch(`${server.url}/api/report`, { headers: { host: `attacker.example:${port}` } });
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain("mutationToken");
  });

  test("validates move requests before touching anything", async () => {
    const { root } = await makeRepository();
    const trashRoot = await temporaryDirectory("worktree-diet-trash-");
    server = startServer([root], { trashRoot });
    const move = (token: string, body: string) =>
      fetch(`${server?.url}/api/move-to-trash`, {
        method: "POST",
        headers: { "content-type": "application/json", [MUTATION_TOKEN_HEADER]: token },
        body,
      });
    const { mutationToken } = await getReport(server.url);
    expect((await move("wrong", JSON.stringify({ worktreePath: root }))).status).toBe(403);
    expect((await move(mutationToken, "not json")).status).toBe(400);
    expect((await move(mutationToken, JSON.stringify({ path: root }))).status).toBe(400);
    expect((await move(mutationToken, JSON.stringify({ worktreePath: "/elsewhere" }))).status).toBe(422);
    expect((await move(mutationToken, JSON.stringify({ worktreePath: root, directories: "dist" }))).status).toBe(400);
    expect((await move(mutationToken, JSON.stringify({ worktreePath: root, directories: [1] }))).status).toBe(400);
  });

  test("moves a scanned worktree's generated folders and returns a fresh report", async () => {
    const { root } = await makeRepository();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle.js"), "x".repeat(4096));
    const trashRoot = await temporaryDirectory("worktree-diet-trash-");
    server = startServer([root], { trashRoot });
    const before = await getReport(server.url);
    expect(before.report.generatedBytes).toBe(4096);
    const response = await fetch(`${server.url}/api/move-to-trash`, {
      method: "POST",
      headers: { "content-type": "application/json", [MUTATION_TOKEN_HEADER]: before.mutationToken },
      body: JSON.stringify({ worktreePath: root, directories: [join(await realpath(root), "dist")] }),
    });
    const moved = await response.json();
    expect(response.status).toBe(200);
    expect(moved.result.moved).toHaveLength(1);
    expect(moved.report.generatedBytes).toBe(0);
    expect(moved.report.scannedAt).toBeGreaterThan(before.report.scannedAt);
  });

  test("rejects a mutation token issued by another server process", async () => {
    const { root } = await makeRepository();
    server = startServer([root]);
    await getReport(server.url);
    const other = startServer([], { demo: createDemoReport() });
    const foreign = await getReport(other.url).finally(() => other.stop());
    const response = await fetch(`${server.url}/api/move-to-trash`, {
      method: "POST",
      headers: { "content-type": "application/json", [MUTATION_TOKEN_HEADER]: foreign.mutationToken },
      body: JSON.stringify({ worktreePath: root }),
    });
    expect(response.status).toBe(403);
  });
});

/** A promise you settle from the test, to control exactly when a scan or move finishes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const fakeReport = (label: string): ScanReport => ({ ...createDemoReport(), roots: [label] });
const noMoves: TrashResult = { moved: [], warnings: [], trashPath: "/trash" };

describe("disk workspace coordination", () => {
  test("concurrent report requests share one scan, and the next request scans again", async () => {
    let scans = 0;
    const workspace = diskWorkspace(
      async () => {
        scans += 1;
        await Bun.sleep(5);
        return fakeReport(`scan ${scans}`);
      },
      async () => noMoves,
    );
    const [first, second, third] = await Promise.all([workspace.report(), workspace.report(), workspace.report()]);
    expect(scans).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    await workspace.report();
    expect(scans).toBe(2);
  });

  test("a scan that started before a move never becomes the report later moves use", async () => {
    const scans: ReturnType<typeof deferred<ScanReport>>[] = [];
    const movedFrom: string[] = [];
    const moving = deferred<TrashResult>();
    const workspace = diskWorkspace(
      () => {
        const scan = deferred<ScanReport>();
        scans.push(scan);
        return scan.promise;
      },
      (report) => {
        movedFrom.push(report.roots[0] ?? "");
        return movedFrom.length === 1 ? moving.promise : Promise.resolve(noMoves);
      },
    );
    const initial = workspace.report();
    scans[0]?.resolve(fakeReport("before"));
    await initial;

    // A scan starts, then a move begins and the scan finishes mid-move: it may have seen half-moved folders.
    const staleScan = workspace.report();
    const firstMove = workspace.move("/work/a").catch((error: unknown) => error);
    scans[1]?.resolve(fakeReport("stale"));
    await staleScan;
    // The move finishes, but its rescan fails, so nothing newer replaces the last good report.
    moving.resolve(noMoves);
    await Bun.sleep(0);
    scans[2]?.reject(new Error("rescan failed"));
    expect(await firstMove).toBeInstanceOf(HttpError);

    const secondMove = workspace.move("/work/b");
    await Bun.sleep(0);
    scans[3]?.resolve(fakeReport("after"));
    await secondMove;
    expect(movedFrom).toEqual(["before", "before"]);
  });

  test("still says folders moved when the rescan after a move fails", async () => {
    let scans = 0;
    const workspace = diskWorkspace(
      async () => {
        scans += 1;
        if (scans > 1) throw new Error("disk unplugged");
        return fakeReport("first");
      },
      async () => ({ ...noMoves, moved: [{ from: "/work/a/dist", to: "/trash/0-dist" }] }),
    );
    await workspace.report();
    const failure = await workspace.move("/work/a").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).message).toBe("Moved 1 folder to Trash, but the rescan failed: disk unplugged");
  });
});
