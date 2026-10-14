import {
  type ErrorResponse,
  type MoveRequest,
  type MoveResponse,
  MUTATION_TOKEN_HEADER,
  type ReportResponse,
} from "../protocol.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("Couldn’t reach Worktree Diet. Is it still running?");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error((body as ErrorResponse | undefined)?.message ?? `Request failed (${response.status})`);
  return body as T;
}

export const fetchReport = (): Promise<ReportResponse> => request("/api/report");

export const moveToTrash = (worktreePath: string, mutationToken: string): Promise<MoveResponse> =>
  request("/api/move-to-trash", {
    method: "POST",
    headers: { "content-type": "application/json", [MUTATION_TOKEN_HEADER]: mutationToken },
    body: JSON.stringify({ worktreePath } satisfies MoveRequest),
  });
