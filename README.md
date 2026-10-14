# Worktree Diet

Worktree Diet is a local macOS-style utility for finding generated storage in Git worktrees across one or more locations. It measures both logical and allocated bytes, identifies inactive candidates with transparent evidence, and can recover space by moving scanned generated directories to Trash.

## Run

```sh
bun install
bun run start -- /path/to/repositories /another/location
```

To try it without scanning anything — or to take screenshots without exposing your own paths — run the demo workspace:

```sh
bun run start -- --demo
```

Demo mode serves a realistic sample workspace from memory. Moving folders to Trash is simulated; nothing on disk is read or touched.

Each argument can be a Git repository/worktree or a parent directory. Parent discovery is bounded to four levels, ignores symbolic links, `.git` internals, and recognised generated directories. The server binds only to `127.0.0.1` and opens a local browser utility; pass `--no-open` to just print its address.

To run it without Bun installed, build a standalone executable with `bun run build` and run `build/worktree-diet` from anywhere.

## What it reports

- repositories and linked worktrees, deduplicated by Git common directory and canonical worktree path;
- branch, Git clean/dirty state, last commit age, and a deliberately non-certain activity label;
- logical and allocated bytes for dependencies, build output, caches, and source/other files;
- outermost generated folders only: `node_modules`, Python environments, `dist`, `target`, `.next`, `.turbo`, and similar recognised directories.

Allocated size prefers filesystem block accounting (`stat.blocks * 512`). A file hardlinked from several places (pnpm stores, shared caches) is counted once per scan, for its alphabetically first path, so totals aren't inflated and per-worktree sizes are the same on every scan. Symbolic links are never followed. Worktrees whose folders were deleted without `git worktree prune`, unreadable paths and moved paths are reported as scan notes rather than failing the scan.

## Move to Trash safety

The only mutation is **Move generated folders to Trash**. The browser sends one selected worktree path, the folders its confirmation dialog listed, and a random per-process token in `x-worktree-diet-token`. The server moves only folders that are both confirmed and in its own latest scan of that worktree, so it never moves a path it didn't find itself, and never moves a folder that appeared after you confirmed. A generated-looking folder that contains another worktree (say, a worktree checked out under `build/`) is treated as source and never offered. API requests must address the server by its own host (`127.0.0.1` or `localhost` and its port), which blocks DNS-rebinding pages from reaching it.

On macOS, folders move by rename into `~/.Trash/Worktree Diet/<unique-id>`. Nothing deletes worktrees, Git metadata, source files, or arbitrary paths. Before each move the folder is re-checked: still a real directory, still inside the worktree, and still at the canonical path the scan saw, so a parent swapped for a symlink since the scan can't redirect it. Cross-volume moves are skipped with an explanation rather than copying and deleting. A fresh scan runs after every move; vanished folders become warnings while the rest can still move.

## Development

```sh
bun run check    # everything below, in order
bun run lint     # Biome: formatting and lint (`bun run format` fixes what it can)
bun run typecheck
bun test
bun run build    # standalone executable at build/worktree-diet
bun run smoke    # runs that executable from another directory and checks the page, assets and API
```

| Path | |
|---|---|
| `src/scanner.ts` | Discovery, measurement, classification and the Trash move |
| `src/server.ts` | Local HTTP server; disk and demo workspaces behind one interface |
| `src/protocol.ts` | HTTP request and response types shared with the browser |
| `src/demo.ts` | The in-memory demo workspace |
| `src/public/` | The browser app: `main.ts` wires `meter`, `list` and `inspector`; `format` and `model` are pure and unit tested |

The scanner and server tests use real temporary Git repositories, linked worktrees, hardlinks and temporary Trash roots. They cover discovery and deduplication, stale and nested worktrees, deterministic hardlink accounting, every activity cause, the move's safety checks, the Host check, and scan sharing and move races (with controlled timing). The frontend's formatting and view logic have unit tests, and the worktree list has DOM tests.

## License

MIT. See [LICENSE](LICENSE).
