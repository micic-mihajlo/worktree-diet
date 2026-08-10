import { resolve } from "node:path";
import { startServer } from "./server.ts";

const args = Bun.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log("Worktree Diet\n\nUsage: bun run start -- <repository-or-parent> [more paths…]\n\nScans Git repositories and worktrees below each path (bounded traversal), then serves a local utility on 127.0.0.1. Moving generated folders to Trash is explicit, recoverable, and only accepts paths from the latest scan.");
  process.exit(args.length === 0 ? 1 : 0);
}
const app = startServer(args.map((path) => resolve(path)));
console.log(`Worktree Diet is running at ${app.url}`);
try { Bun.spawn(["open", app.url], { stdout: "ignore", stderr: "ignore" }); } catch { /* The server remains usable without a desktop opener. */ }
