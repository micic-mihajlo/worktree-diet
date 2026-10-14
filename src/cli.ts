import { resolve } from "node:path";
import { createDemoReport } from "./demo.ts";
import { startServer } from "./server.ts";

const args = Bun.argv.slice(2);
const demo = args.includes("--demo");
const paths = args.filter((arg) => arg !== "--demo");
if ((paths.length === 0 && !demo) || args.includes("--help") || args.includes("-h")) {
  console.log(
    "Worktree Diet\n\nUsage: bun run start -- <repository-or-parent> [more paths…]\n       bun run start -- --demo\n\nScans Git repositories and worktrees below each path (bounded traversal), then serves a local utility on 127.0.0.1. Moving generated folders to Trash is explicit, recoverable, and only accepts paths from the latest scan.\n\n--demo serves a realistic sample workspace instead of scanning, for screenshots and sharing. Moves are simulated; nothing on disk is touched.",
  );
  process.exit(paths.length === 0 && !demo ? 1 : 0);
}
const app = demo ? startServer([], { demo: createDemoReport() }) : startServer(paths.map((path) => resolve(path)));
console.log(`Worktree Diet${demo ? " (demo)" : ""} is running at ${app.url}`);
try {
  Bun.spawn(["open", app.url], { stdout: "ignore", stderr: "ignore" });
} catch {
  /* The server remains usable without a desktop opener. */
}
