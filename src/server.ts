import { simulateMove } from "./demo.ts";
import index from "./public/index.html";
import { moveGeneratedDirectories, type ScanReport, scanWorkspace, type TrashResult } from "./scanner.ts";

/** Response bodies, shared with the browser client. */
export interface ReportResponse {
  report: ScanReport;
  mutationToken: string;
}
export interface MoveResponse extends ReportResponse {
  result: TrashResult;
}
export interface ErrorResponse {
  message: string;
}
export const MUTATION_TOKEN_HEADER = "x-worktree-diet-token";

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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Where reports come from and how moves happen: the real disk, or the in-memory demo. */
interface Workspace {
  report(): Promise<ScanReport>;
  move(worktreePath: string): Promise<{ result: TrashResult; report: ScanReport }>;
}

function diskWorkspace(inputPaths: readonly string[], trashRoot: string | undefined): Workspace {
  let latest: ScanReport | undefined;
  let inFlight: { generation: number; scan: Promise<ScanReport> } | undefined;
  // Bumped after every move, so a scan that started before or during the move never becomes `latest`.
  let generation = 0;

  // Concurrent report requests share one scan instead of each walking the disk.
  const scan = (): Promise<ScanReport> => {
    if (inFlight?.generation === generation) return inFlight.scan;
    const startedAt = generation;
    const scan = scanWorkspace(inputPaths)
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
    async move(worktreePath) {
      if (!latest) throw new HttpError(400, "Scan before moving generated folders to Trash.");
      let result: TrashResult;
      try {
        result = await moveGeneratedDirectories(latest, worktreePath, trashRoot === undefined ? {} : { trashRoot });
      } finally {
        generation += 1;
      }
      return { result, report: await scan() };
    },
  };
}

function demoWorkspace(initial: ScanReport): Workspace {
  let latest = initial;
  return {
    report: async () => ({ ...latest, scannedAt: Date.now() }),
    async move(worktreePath) {
      const simulated = simulateMove(latest, worktreePath);
      latest = simulated.report;
      return simulated;
    },
  };
}

function parseMoveRequest(value: unknown): { worktreePath: string } {
  if (value && typeof value === "object" && "worktreePath" in value && typeof value.worktreePath === "string")
    return { worktreePath: value.worktreePath };
  throw new HttpError(400, "Provide the selected worktree path.");
}

export function startServer(inputPaths: readonly string[], options: ServerOptions = {}): LocalServer {
  const workspace = options.demo ? demoWorkspace(options.demo) : diskWorkspace(inputPaths, options.trashRoot);
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
          return { ...(await workspace.move(parseMoveRequest(body).worktreePath)), mutationToken };
        }),
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
