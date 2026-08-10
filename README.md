# Worktree Diet

Worktree Diet is a local macOS-style utility for finding generated storage in Git worktrees across one or more locations. It measures both logical and allocated bytes, identifies inactive candidates with transparent evidence, and can recover space by moving scanned generated directories to Trash.

## Run

```sh
bun install
bun run start -- /path/to/repositories /another/location
```

Each argument can be a Git repository/worktree or a parent directory. Parent discovery is bounded to four levels, ignores symbolic links, `.git` internals, and recognised generated directories. The server binds only to `127.0.0.1` and opens a local browser utility.

## What it reports

- repositories and linked worktrees, deduplicated by Git common directory and canonical worktree path;
- branch, Git clean/dirty state, last commit age, and a deliberately non-certain activity label;
- logical and allocated bytes for dependencies, build output, caches, and source/other files;
- outermost generated folders only: `node_modules`, Python environments, `dist`, `target`, `.next`, `.turbo`, and similar recognised directories.

Allocated size prefers filesystem block accounting (`stat.blocks * 512`). Files with the same device and inode are counted once per scan, avoiding inflated pnpm-style hardlink measurements. Symbolic links are never followed. Unreadable or moved paths are reported as scan notes.

## Move to Trash safety

The only mutation is **Move generated folders to Trash**. The browser sends one selected worktree path plus a random per-process token in `x-worktree-diet-token`. The server derives the allowable generated directories from its latest report; it does not accept a browser-supplied path list.

On macOS, folders move by rename into `~/.Trash/Worktree Diet/<unique-id>`. Nothing deletes worktrees, Git metadata, source files, or arbitrary paths. Cross-volume moves report an actionable error rather than copying and deleting. A fresh scan runs after every move; vanished folders become warnings while the rest can still move.

## Development

```sh
bun test
bun run typecheck
bun run build
bun run check
```

The integration tests use real temporary Git repositories, linked worktrees, filesystem hardlinks, and temporary Trash roots. They cover multi-root discovery and deduplication, allocated accounting, heuristic evidence, recoverable moves, and rejecting an unscanned worktree at the mutation boundary.

## License

MIT. See [LICENSE](LICENSE).
