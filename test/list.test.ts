import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorktreeList } from "../src/public/list.ts";
import type { WorktreeRecord } from "../src/scanner.ts";
import { record } from "./records.ts";

// A DOM for this file only; unregistered afterwards so other files keep Bun's own globals (fetch, etc.).
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

// The row template comes from the real page, so these tests can't drift from the markup.
const page = await readFile(join(import.meta.dir, "../src/public/index.html"), "utf8");
const template = page.match(/<template id="row-template">[\s\S]*?<\/template>/)?.[0] ?? "";

let list: WorktreeList;
let selected: WorktreeRecord[];
beforeEach(async () => {
  const { WorktreeList } = await import("../src/public/list.ts");
  document.body.innerHTML = `<div id="list" role="listbox"></div>${template}`;
  selected = [];
  list = new WorktreeList(
    document.querySelector<HTMLElement>("#list") as HTMLElement,
    document.querySelector<HTMLTemplateElement>("#row-template") as HTMLTemplateElement,
    (chosen) => selected.push(chosen),
  );
});

const a = record({ path: "/work/a", branch: "a", generatedAllocatedBytes: 300 });
const b = record({ path: "/work/b", branch: "b", generatedAllocatedBytes: 200 });
const c = record({ path: "/work/c", branch: "c", generatedAllocatedBytes: 100 });

const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".worktree-row")];
const shown = () => rows().filter((row) => !row.hidden);
const branches = (elements: HTMLElement[]) => elements.map((row) => row.querySelector(".branch")?.textContent);
const tabStops = () => shown().filter((row) => row.tabIndex === 0);

describe("worktree list", () => {
  test("removes the previous report's rows even when the new view shows nothing", () => {
    list.build([a, b], new Set(), a.path);
    list.show([a, b], false);
    const previous = rows();
    // After a move, a filter can match nothing: no row from the old report may linger.
    list.build([record({ ...a, generatedAllocatedBytes: 0 }), b], new Set(), a.path);
    list.show([], false);
    expect(previous.some((row) => row.isConnected)).toBe(false);
    expect(shown()).toEqual([]);
  });

  test("hides filtered rows without reordering, and reorders when the order changes", () => {
    list.build([a, b, c], new Set(), a.path);
    list.show([a, b, c], false);
    const before = rows();
    list.show([a, c], false);
    expect(rows()).toEqual(before);
    expect(branches(shown())).toEqual(["a", "c"]);
    list.show([c, b, a], false);
    expect(branches(shown())).toEqual(["c", "b", "a"]);
    expect(branches(rows())).toEqual(["c", "b", "a"]);
  });

  test("keeps exactly one tab stop as filters change and the selection moves", () => {
    list.build([a, b, c], new Set(), a.path);
    list.show([a, b, c], false);
    expect(branches(tabStops())).toEqual(["a"]);
    list.show([b, c], false); // the selected row is filtered out
    expect(branches(tabStops())).toEqual(["b"]);
    list.select(c.path);
    expect(branches(tabStops())).toEqual(["c"]);
    list.show([], false);
    expect(tabStops()).toEqual([]);
    list.show([a, b, c], false);
    expect(branches(tabStops())).toEqual(["c"]);
  });

  test("arrow keys, Home and End select among shown rows only", () => {
    list.build([a, b, c], new Set(), a.path);
    list.show([a, c], false);
    const [first] = shown();
    first?.focus();
    const press = (key: string) =>
      document.querySelector("#list")?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    press("ArrowDown");
    press("ArrowDown");
    press("Home");
    press("End");
    expect(selected.map((chosen) => chosen.branch)).toEqual(["c", "c", "a", "c"]);
  });
});
