import { join } from "node:path";
import { cleanupCommand, scanRepository, type ScanReport } from "./scanner.ts";

const publicDirectory = join(import.meta.dir, "public");
const assets: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface LocalServer {
  url: string;
  stop(): void;
}

export function startServer(repositoryPath: string, port = 0): LocalServer {
  let latestReport: ScanReport | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/report") {
        try {
          const report = await scanRepository(repositoryPath);
          latestReport = report;
          return Response.json({ state: "complete", report });
        } catch (error) {
          return Response.json({
            state: "error",
            message: error instanceof Error ? error.message : "Unable to scan the repository",
            report: latestReport,
          }, { status: 422 });
        }
      }
      if (url.pathname === "/api/cleanup-command") {
        const path = url.searchParams.get("path");
        if (!path || !latestReport) return Response.json({ message: "Scan a repository before copying a command." }, { status: 400 });
        const allowed = latestReport.worktrees.some((worktree) => worktree.generatedDirectories.some((directory) => directory.path === path));
        if (!allowed) return Response.json({ message: "That path was not returned by this scan." }, { status: 403 });
        return Response.json({ command: cleanupCommand(path) });
      }
      const asset = assets[url.pathname];
      if (!asset) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(publicDirectory, asset));
      if (!await file.exists()) return new Response("Missing application asset", { status: 500 });
      const extension = asset.slice(asset.lastIndexOf("."));
      return new Response(file, { headers: { "content-type": contentTypes[extension] ?? "application/octet-stream", "cache-control": "no-store" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
