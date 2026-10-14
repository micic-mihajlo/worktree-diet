import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDemoReport } from "../src/demo.ts";
import { MUTATION_TOKEN_HEADER, type ReportResponse } from "../src/protocol.ts";
import { type LocalServer, startServer } from "../src/server.ts";
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

  test("shares one scan between concurrent report requests", async () => {
    const { root } = await makeRepository();
    server = startServer([root]);
    const [first, second] = await Promise.all([getReport(server.url), getReport(server.url)]);
    expect(first.report.scannedAt).toBe(second.report.scannedAt);
    // Once that scan is done, the next request scans again.
    await Bun.sleep(5);
    expect((await getReport(server.url)).report.scannedAt).toBeGreaterThan(first.report.scannedAt);
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
      body: JSON.stringify({ worktreePath: root }),
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
