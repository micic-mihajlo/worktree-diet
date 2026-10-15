// Runs the compiled binary from an unrelated directory and checks that the page, every asset it
// references, and the API all work. `bun run build` used to emit a server whose page and assets 500'd.
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const binary = resolve(import.meta.dir, "../build/worktree-diet");
const child = Bun.spawn([binary, "--demo", "--no-open"], { cwd: tmpdir(), stdout: "pipe", stderr: "inherit" });
const fail = (message: string): never => {
  child.kill();
  console.error(`smoke test failed: ${message}`);
  process.exit(1);
};

const reader = child.stdout.getReader();
let output = "";
const deadline = Date.now() + 10_000;
while (!/http:\/\/\S+/.test(output)) {
  if (Date.now() > deadline) fail("the server did not print its address within 10s");
  const { value, done } = await reader.read();
  if (done) fail(`the server exited early:\n${output}`);
  output += new TextDecoder().decode(value);
}
const url = output.match(/http:\/\/\S+/)?.[0] ?? fail("no address");

const page = await fetch(url);
if (!page.ok) fail(`GET / returned ${page.status}`);
const html = await page.text();
const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1] ?? "");
if (!assets.some((asset) => asset.endsWith(".js"))) fail("the page references no script");
if (!assets.some((asset) => asset.endsWith(".css"))) fail("the page references no stylesheet");
for (const asset of assets) {
  const response = await fetch(new URL(asset, url));
  if (!response.ok) fail(`GET ${asset} returned ${response.status}`);
}
const api = await fetch(new URL("/api/report", url));
const body = (await api.json()) as { report?: { worktrees?: unknown[] } };
if (!api.ok || !body.report?.worktrees?.length) fail(`GET /api/report returned ${api.status}`);

child.kill();
console.log(`smoke test passed: page, ${assets.length} assets and the API work from ${tmpdir()}`);
