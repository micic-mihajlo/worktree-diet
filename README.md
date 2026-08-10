# Worktree Diet

A local, read-only dashboard for measuring the disk weight of Git worktrees. It makes checked-out files and likely generated artifacts visible across linked branches without deleting anything.

## Run

```sh
bun install
bun run start -- /path/to/repository
```

The server binds only to `127.0.0.1`, opens the dashboard locally, and accepts no path through its HTTP API. Refreshing rescans the repository supplied at startup. Use `bun run start -- --help` for usage.

## What it measures

Worktree Diet reads `git worktree list --porcelain`, Git status, the most recent commit time, and file sizes underneath every returned worktree. It classifies file size into:

- dependencies: `node_modules`, Python environments, and vendor folders;
- build output: `dist`, `target`, `.next`, and similar outputs;
- caches: `.turbo`, `.cache`, `.vite`, and similar caches;
- source / other: checked-out files not in those generated directories.

The generated figure is an **estimate of avoidable weight**, not a claim that bytes are identical across branches. Symbolic links are skipped; unreadable or vanishing paths become scan notes.

The dashboard can copy a safely quoted `rm -rf -- '…'` command for an observed generated directory. It never executes that command. Confirm a branch is inactive before you remove generated folders yourself.

## Development

```sh
bun test
bun run typecheck
bun run build
```

The integration tests create real temporary Git repositories and linked worktrees. They use the production scanner to cover classification, dirty state, symlink safety, invalid inputs, and shell quoting.

## Background

- [Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [git-worktree.org FAQ](https://www.git-worktree.org/faq)
- [Code Cleaner](https://code-cleaner.com/)
- [agent-worktree](https://github.com/nekocode/agent-worktree)

## License

MIT. See [LICENSE](LICENSE).
