// The HTTP contract between the server and the browser client. Both import this file, so it must hold
// only types and plain constants: anything else would be bundled into the page.
import type { ScanReport, TrashResult } from "./scanner.ts";

export const MUTATION_TOKEN_HEADER = "x-worktree-diet-token";

/** GET /api/report */
export interface ReportResponse {
  report: ScanReport;
  mutationToken: string;
}
/** POST /api/move-to-trash with a `MoveRequest` body and the token header. */
export interface MoveRequest {
  worktreePath: string;
  /**
   * The folders the user confirmed. Only those that are also in the server's latest scan move, so nothing
   * that appeared since is moved unseen. Omit to move every generated folder the scan found.
   */
  directories?: string[];
}
export interface MoveResponse extends ReportResponse {
  result: TrashResult;
}
/** Any non-2xx API response. */
export interface ErrorResponse {
  message: string;
}
