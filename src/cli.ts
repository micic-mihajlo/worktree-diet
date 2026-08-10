import { resolve } from "node:path";
import { startServer } from "./server.ts";

const args = Bun.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log("Worktree Diet\n\nUsage: bun run start -- /path/to/repository\n\nStarts a read-only dashboard on 127.0.0.1. It never modifies scanned repositories.");
  process.exit(args.length === 0 ? 1 : 0);
}
if (args.length !== 1) {
  console.error("Expected exactly one repository path. Run with --help for usage.");
  process.exit(1);
}
const app = startServer(resolve(args[0] ?? ""));
console.log(`Worktree Diet is running at ${app.url}`);
try {
  Bun.spawn(["open", app.url], { stdout: "ignore", stderr: "ignore" });
} catch {
  // The server remains usable when no desktop opener is available.
}
