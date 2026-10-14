import { simulateMove } from "./demo.ts";
import {
  type ErrorResponse,
  type MoveRequest,
  type MoveResponse,
  MUTATION_TOKEN_HEADER,
  type ReportResponse,
} from "./protocol.ts";
import index from "./public/index.html";
import { moveGeneratedDirectories, type ScanReport, scanWorkspace, type TrashResult } from "./scanner.ts";

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

/** Where reports come from and how moves happen: the real disk, or the in-memory demo. */
export interface Workspace {
  report(): Promise<ScanReport>;
  move(worktreePath: string, confirmed?: readonly string[]): Promise<{ result: TrashResult; report: ScanReport }>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Scans and moves on disk. Takes its scan and move as functions so the coordination below can be tested
 * with controlled timing.
 */
export function diskWorkspace(
  scanDisk: () => Promise<ScanReport>,
  moveOnDisk: (report: ScanReport, worktreePath: string, confirmed?: readonly string[]) => Promise<TrashResult>,
): Workspace {
  let latest: ScanReport | undefined;
  let inFlight: { generation: number; scan: Promise<ScanReport> } | undefined;
  // Bumped when a move starts and when it ends, so a scan that began before or during a move (and so may
  // have seen folders half-moved) is returned to its caller but never becomes `latest`.
  let generation = 0;

  // Concurrent report requests share one scan instead of each walking the disk.
  const scan = (): Promise<ScanReport> => {
    if (inFlight?.generation === generation) return inFlight.scan;
    const startedAt = generation;
    const scan = scanDisk()
      .then((report) => {
        if (startedAt === generation) latest = report;
        return report;
      })
      .finally(() => {
        if (inFlight?.scan === scan) inFlight = undefined;
      });
    inFlight = { generation: startedAt, scan };
    return scan;
  };

  return {
    report: scan,
    async move(worktreePath, confirmed) {
      if (!latest) throw new HttpError(400, "Scan before moving generated folders to Trash.");
      generation += 1;
      let result: TrashResult;
      try {
        result = await moveOnDisk(latest, worktreePath, confirmed);
      } finally {
        generation += 1;
      }
      try {
        return { result, report: await scan() };
      } catch (error) {
        const moved = result.moved.length;
        throw new HttpError(
          500,
          `Moved ${moved} ${moved === 1 ? "folder" : "folders"} to Trash, but the rescan failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    },
  };
}

function demoWorkspace(initial: ScanReport): Workspace {
  let latest = initial;
  return {
    report: async () => ({ ...latest, scannedAt: Date.now() }),
    async move(worktreePath, confirmed) {
      const simulated = simulateMove(latest, worktreePath, confirmed);
      latest = simulated.report;
      return simulated;
    },
  };
}

function parseMoveRequest(value: unknown): MoveRequest {
  if (!value || typeof value !== "object" || !("worktreePath" in value) || typeof value.worktreePath !== "string")
    throw new HttpError(400, "Provide the selected worktree path.");
  if (!("directories" in value) || value.directories === undefined) return { worktreePath: value.worktreePath };
  const { directories } = value;
  if (!Array.isArray(directories) || !directories.every((directory) => typeof directory === "string"))
    throw new HttpError(400, "`directories` must be a list of paths.");
  return { worktreePath: value.worktreePath, directories };
}

export function startServer(inputPaths: readonly string[], options: ServerOptions = {}): LocalServer {
  const { trashRoot } = options;
  const workspace = options.demo
    ? demoWorkspace(options.demo)
    : diskWorkspace(
        () => scanWorkspace(inputPaths),
        (report, worktreePath, confirmed) =>
          moveGeneratedDirectories(report, worktreePath, {
            ...(trashRoot === undefined ? {} : { trashRoot }),
            ...(confirmed === undefined ? {} : { confirmed }),
          }),
      );
  const mutationToken = crypto.randomUUID();

  // The page is public code, but the API reads your file paths and moves folders. Requiring our own Host
  // stops a DNS-rebinding site from reaching it as if it were same-origin.
  const api =
    (handler: (request: Request) => Promise<unknown>) =>
    async (request: Request): Promise<Response> => {
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`)
        return Response.json({ message: "Unexpected host." } satisfies ErrorResponse, { status: 403 });
      try {
        return Response.json(await handler(request));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 422;
        const message = error instanceof Error ? error.message : "Something went wrong.";
        return Response.json({ message } satisfies ErrorResponse, { status });
      }
    };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    // Scans of large folders can take a while; don't drop the request.
    idleTimeout: 255,
    development: false,
    routes: {
      "/": index,
      "/api/report": {
        GET: api(async (): Promise<ReportResponse> => ({ report: await workspace.report(), mutationToken })),
      },
      "/api/move-to-trash": {
        POST: api(async (request): Promise<MoveResponse> => {
          if (request.headers.get(MUTATION_TOKEN_HEADER) !== mutationToken)
            throw new HttpError(403, "A valid scan token is required to move generated folders.");
          const body: unknown = await request.json().catch(() => {
            throw new HttpError(400, "Request body must be JSON.");
          });
          const { worktreePath, directories } = parseMoveRequest(body);
          return { ...(await workspace.move(worktreePath, directories)), mutationToken };
        }),
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
