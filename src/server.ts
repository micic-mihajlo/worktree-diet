import { join } from "node:path";
import { simulateMove } from "./demo.ts";
import { moveGeneratedDirectories, type ScanReport, scanWorkspace } from "./scanner.ts";

const publicDirectory = join(import.meta.dir, "public");
const assets: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/fonts/Geist-Variable.woff2": "fonts/Geist-Variable.woff2",
  "/fonts/GeistMono-Variable.woff2": "fonts/GeistMono-Variable.woff2",
  "/fonts/GeistPixel-Square.woff2": "fonts/GeistPixel-Square.woff2",
  "/fonts/LICENSE.txt": "fonts/LICENSE.txt",
};
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
export interface LocalServer {
  url: string;
  stop(): void;
}
/** `demo` replaces scanning with an in-memory report; moves are simulated and never touch disk. */
export interface ServerOptions {
  port?: number;
  trashRoot?: string;
  demo?: ScanReport;
}

function parseMoveRequest(value: unknown): { worktreePath: string } | undefined {
  if (!value || typeof value !== "object" || !("worktreePath" in value) || typeof value.worktreePath !== "string")
    return undefined;
  return { worktreePath: value.worktreePath };
}

export function startServer(inputPaths: readonly string[], options: ServerOptions = {}): LocalServer {
  let latestReport: ScanReport | undefined = options.demo;
  const mutationToken = crypto.randomUUID();
  const demo = options.demo !== undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/report" && request.method === "GET") {
        if (demo && latestReport)
          return Response.json({
            state: "complete",
            report: { ...latestReport, scannedAt: Date.now() },
            mutationToken,
          });
        try {
          const report = await scanWorkspace(inputPaths);
          latestReport = report;
          return Response.json({ state: "complete", report, mutationToken });
        } catch (error) {
          return Response.json(
            {
              state: "error",
              message: error instanceof Error ? error.message : "Unable to scan the selected paths",
              report: latestReport,
            },
            { status: 422 },
          );
        }
      }
      if (url.pathname === "/api/move-to-trash" && request.method === "POST") {
        if (request.headers.get("x-worktree-diet-token") !== mutationToken)
          return Response.json(
            { message: "A valid scan token is required to move generated folders." },
            { status: 403 },
          );
        if (!latestReport)
          return Response.json({ message: "Scan before moving generated folders to Trash." }, { status: 400 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ message: "Request body must be JSON." }, { status: 400 });
        }
        const parsed = parseMoveRequest(body);
        if (!parsed) return Response.json({ message: "Provide the selected worktree path." }, { status: 400 });
        if (demo) {
          try {
            const simulated = simulateMove(latestReport, parsed.worktreePath);
            latestReport = simulated.report;
            return Response.json({ result: simulated.result, report: simulated.report, mutationToken });
          } catch (error) {
            return Response.json(
              { message: error instanceof Error ? error.message : "Unable to move generated folders to Trash." },
              { status: 422 },
            );
          }
        }
        try {
          const result =
            options.trashRoot === undefined
              ? await moveGeneratedDirectories(latestReport, parsed.worktreePath)
              : await moveGeneratedDirectories(latestReport, parsed.worktreePath, { trashRoot: options.trashRoot });
          const report = await scanWorkspace(inputPaths);
          latestReport = report;
          return Response.json({ result, report, mutationToken });
        } catch (error) {
          return Response.json(
            { message: error instanceof Error ? error.message : "Unable to move generated folders to Trash." },
            { status: 422 },
          );
        }
      }
      const asset = assets[url.pathname];
      if (!asset) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(publicDirectory, asset));
      if (!(await file.exists())) return new Response("Missing application asset", { status: 500 });
      const extension = asset.slice(asset.lastIndexOf("."));
      return new Response(file, {
        headers: { "content-type": contentTypes[extension] ?? "application/octet-stream", "cache-control": "no-store" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
