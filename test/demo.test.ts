import { describe, expect, test } from "bun:test";
import { createDemoReport, simulateMove } from "../src/demo.ts";
import { startServer } from "../src/server.ts";

describe("demo mode", () => {
  test("builds a consistent report covering every recommendation", () => {
    const report = createDemoReport();
    expect(report.generatedAllocatedBytes).toBe(
      report.worktrees.reduce((sum, record) => sum + record.generatedAllocatedBytes, 0),
    );
    expect(new Set(report.worktrees.map((record) => record.activity.state))).toEqual(
      new Set(["likely-inactive", "review", "recent"]),
    );
    for (const record of report.worktrees)
      expect(record.generatedAllocatedBytes).toBe(
        record.generatedDirectories.reduce((sum, directory) => sum + directory.allocatedBytes, 0),
      );
  });

  test("scales to large workspaces with unique worktree paths", () => {
    const report = createDemoReport({ worktreeCount: 400 });
    expect(report.worktrees).toHaveLength(400);
    expect(new Set(report.worktrees.map((record) => record.path)).size).toBe(400);
  });

  test("simulated moves free exactly that worktree's generated storage", () => {
    const report = createDemoReport();
    const target = report.worktrees.find((record) => record.activity.state === "likely-inactive");
    if (!target) throw new Error("The demo needs a likely-inactive worktree");
    const { result, report: next } = simulateMove(report, target.path);
    expect(result.moved).toHaveLength(target.generatedDirectories.length);
    expect(next.generatedAllocatedBytes).toBe(report.generatedAllocatedBytes - target.generatedAllocatedBytes);
    expect(next.worktrees.find((record) => record.path === target.path)?.generatedDirectories).toEqual([]);
    expect(() => simulateMove(report, "/elsewhere")).toThrow("latest scan");
  });

  test("serves the demo report and simulates moves through the token-guarded endpoint", async () => {
    const server = startServer([], { demo: createDemoReport() });
    try {
      const { report, mutationToken } = await (await fetch(`${server.url}/api/report`)).json();
      const target = report.worktrees.find(
        (record: { activity: { state: string } }) => record.activity.state === "likely-inactive",
      );
      const move = (token: string, worktreePath: string) =>
        fetch(`${server.url}/api/move-to-trash`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-worktree-diet-token": token },
          body: JSON.stringify({ worktreePath }),
        });
      expect((await move("wrong", target.path)).status).toBe(403);
      expect((await move(mutationToken, "/elsewhere")).status).toBe(422);
      const moved = await (await move(mutationToken, target.path)).json();
      expect(moved.report.generatedAllocatedBytes).toBe(
        report.generatedAllocatedBytes - target.generatedAllocatedBytes,
      );
      const again = await (await fetch(`${server.url}/api/report`)).json();
      expect(again.report.generatedAllocatedBytes).toBe(moved.report.generatedAllocatedBytes);
    } finally {
      server.stop();
    }
  });
});
