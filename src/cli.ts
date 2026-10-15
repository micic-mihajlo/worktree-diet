import { resolve } from "node:path";
import { createDemoReport } from "./demo.ts";
import { startServer } from "./server.ts";

const usage = `Worktree Diet

Usage: worktree-diet <repository-or-parent> [more paths…]
       worktree-diet --demo

Scans Git repositories and worktrees below each path (bounded traversal), then serves a local utility
on 127.0.0.1. Moving generated folders to Trash is explicit, recoverable, and only accepts paths from
the latest scan.

Options:
  --demo      Serve a realistic sample workspace instead of scanning. Moves are simulated; nothing on
              disk is touched. Useful for trying it out and for screenshots.
  --no-open   Don't open a browser; just print the address.
  -h, --help  Show this help.`;

const options = new Set(["--demo", "--no-open", "--help", "-h"]);
const args = Bun.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("-")));
const paths = args.filter((arg) => !arg.startsWith("-"));
const unknown = [...flags].filter((flag) => !options.has(flag));

if (flags.has("--help") || flags.has("-h")) {
  console.log(usage);
  process.exit(0);
}
if (unknown.length > 0 || (paths.length === 0 && !flags.has("--demo"))) {
  if (unknown.length > 0) console.error(`Unknown option: ${unknown.join(", ")}\n`);
  console.error(usage);
  process.exit(1);
}

const demo = flags.has("--demo");
const app = demo ? startServer([], { demo: createDemoReport() }) : startServer(paths.map((path) => resolve(path)));
console.log(`Worktree Diet${demo ? " (demo)" : ""} is running at ${app.url}`);

if (!flags.has("--no-open")) {
  const opener =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", '""']
        : ["xdg-open"];
  try {
    Bun.spawn([...opener, app.url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No desktop opener (a server or container): the printed address still works.
  }
}
