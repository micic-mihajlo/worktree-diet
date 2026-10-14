import type { ActivityState } from "../scanner.ts";
import { element } from "./dom.ts";
import { byteParts, byteScale, formatBytes } from "./format.ts";
import { apportionCells } from "./model.ts";

export type MeterLayer = ActivityState | "freed";
const layers: readonly MeterLayer[] = ["likely-inactive", "review", "recent", "freed"];
const words: Record<MeterLayer, string> = {
  "likely-inactive": "ready",
  review: "review",
  recent: "recent",
  freed: "freed",
};

// Geometry: must match --cell and --gap on .hero in styles.css.
const CELL_GAP = 3;
const CELL_PITCH = 10 + CELL_GAP;
const SWEEP_MS = 1100;

export interface MeterElements {
  hero: HTMLElement;
  meter: HTMLElement;
  labels: HTMLElement;
  readyValue: HTMLElement;
  readyUnit: HTMLElement;
}

/**
 * The hero's pixel meter and "ready to reclaim" number.
 *
 * Each layer spans from the meter's left edge to its cumulative end and is scaled, never resized, so
 * every change is a compositor-only transform; stepping by whole cells keeps the motion pixel-true.
 * The scale holds the largest total seen this session, so space you free shows up as freed cells.
 */
export class StorageMeter {
  readonly #elements: MeterElements;
  readonly #layers: Record<MeterLayer, HTMLElement>;
  readonly #labels: Record<MeterLayer, HTMLElement>;
  readonly #reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  #columns = 0;
  #scale = 0;
  #latest: { bytes: Record<MeterLayer, number>; ready: number } | undefined;
  #ends: Record<MeterLayer, number> | undefined;
  #introPending = false;
  #revealStarted = false;
  #labelsDrawn = false;
  #labelTimer: ReturnType<typeof setTimeout> | undefined;
  #shownReady: number | undefined;
  #counter = 0;

  constructor(elements: MeterElements) {
    this.#elements = elements;
    this.#layers = Object.fromEntries(
      layers.map((layer) => [layer, element(`.layer.${layer}`, elements.meter)]),
    ) as Record<MeterLayer, HTMLElement>;
    this.#labels = Object.fromEntries(
      layers.map((layer) => {
        const label = document.createElement("span");
        label.className = "meter-label";
        elements.labels.append(label);
        return [layer, label];
      }),
    ) as Record<MeterLayer, HTMLElement>;
    new ResizeObserver(([entry]) => this.#resize(entry?.contentRect.width ?? 0)).observe(elements.hero);
  }

  /** Draws new totals. With `intro`, the meter reveals cell by cell and the number counts up. */
  update(totals: Record<ActivityState, number>, generatedBytes: number, intro: boolean): void {
    this.#scale = Math.max(this.#scale, generatedBytes);
    const bytes = { ...totals, freed: this.#scale - generatedBytes };
    this.#latest = { bytes, ready: totals["likely-inactive"] };
    if (intro) this.#introPending = true;
    this.#elements.meter.setAttribute(
      "aria-label",
      layers
        .filter((layer) => bytes[layer] > 0)
        .map((layer) => `${formatBytes(bytes[layer])} ${words[layer]}`)
        .join(", "),
    );
    this.#draw();
  }

  #resize(width: number): void {
    const columns = Math.floor((width + CELL_GAP) / CELL_PITCH);
    if (columns === this.#columns) return;
    this.#columns = columns;
    this.#ends = undefined;
    this.#elements.hero.style.setProperty("--columns", String(columns));
    this.#elements.hero.classList.add("is-instant");
    this.#draw();
    requestAnimationFrame(() => this.#elements.hero.classList.remove("is-instant"));
  }

  #draw(): void {
    const latest = this.#latest;
    if (!this.#columns || !latest) return;
    const counts = apportionCells(
      layers.map((layer) => latest.bytes[layer]),
      this.#columns,
    );
    const ends = {} as Record<MeterLayer, number>;
    let end = 0;
    for (const [index, layer] of layers.entries()) {
      end += counts[index] ?? 0;
      ends[layer] = end;
    }
    const intro = this.#introPending && !this.#reducedMotion.matches;
    this.#introPending = false;
    const previous = this.#ends;
    const moved = previous ? Math.max(...layers.map((layer) => Math.abs(ends[layer] - previous[layer]))) : 0;
    const duration = intro || moved === 0 ? 0 : Math.min(1200, Math.max(450, moved * 45));
    this.#elements.hero.style.setProperty("--duration", `${duration}ms`);

    const width = this.#columns * CELL_PITCH;
    for (const layer of layers) {
      const style = this.#layers[layer].style;
      style.setProperty("--steps", String(Math.max(1, Math.abs(ends[layer] - (previous?.[layer] ?? 0)))));
      style.transform = `scaleX(${ends[layer] ? (ends[layer] * CELL_PITCH - CELL_GAP / 2) / width : 0})`;
    }
    this.#ends = ends;

    // The legend changes in one step once the cells finish moving, so it never runs ahead of the meter
    // or reflows the page mid-animation.
    clearTimeout(this.#labelTimer);
    if (duration && this.#labelsDrawn)
      this.#labelTimer = setTimeout(() => this.#drawLabels(latest.bytes, counts, ends, false), duration);
    else this.#drawLabels(latest.bytes, counts, ends, intro);

    if (intro) {
      this.#revealStarted = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          this.#elements.hero.style.setProperty("--sweep", `${SWEEP_MS}ms`);
          this.#elements.hero.classList.add("is-revealed");
          // Labels fade in as the sweep reaches them; afterwards they respond immediately.
          setTimeout(() => {
            for (const label of Object.values(this.#labels)) label.style.removeProperty("--reveal-delay");
          }, SWEEP_MS);
        }),
      );
      // Count up while the "ready" cells light up.
      this.#count(0, latest.ready, Math.max(350, (SWEEP_MS * ends["likely-inactive"]) / this.#columns));
    } else {
      if (!this.#revealStarted) {
        this.#revealStarted = true;
        this.#elements.hero.classList.add("is-revealed");
      }
      this.#count(this.#shownReady ?? latest.ready, latest.ready, duration);
    }
  }

  /**
   * Labels flow left to right, each at least as wide as its segment, so a label that fits sits under its
   * segment and one that doesn't pushes the rest along (wrapping if needed) instead of being hidden.
   */
  #drawLabels(
    bytes: Record<MeterLayer, number>,
    counts: number[],
    ends: Record<MeterLayer, number>,
    intro: boolean,
  ): void {
    const last = layers.findLast((layer) => bytes[layer] > 0);
    for (const [index, layer] of layers.entries()) {
      const label = this.#labels[layer];
      const cells = counts[index] ?? 0;
      label.innerHTML = `<i class="dot ${layer}"></i><b>${formatBytes(bytes[layer])}</b> ${words[layer]}`;
      label.style.width = `${cells * CELL_PITCH}px`;
      if (intro)
        label.style.setProperty(
          "--reveal-delay",
          `${Math.round((SWEEP_MS * (ends[layer] - cells)) / this.#columns)}ms`,
        );
      label.classList.toggle("is-empty", bytes[layer] <= 0);
      label.classList.toggle("is-last", layer === last);
    }
    this.#labelsDrawn = true;
  }

  #setReady(bytes: number): void {
    const [value, unit] = byteParts(bytes);
    this.#elements.readyValue.textContent = value;
    this.#elements.readyUnit.textContent = unit;
    this.#elements.readyValue.style.width = "";
    this.#elements.readyValue.classList.remove("is-counting");
    this.#shownReady = bytes;
  }

  /**
   * Counts in the larger value's unit so the unit never flickers. While counting, the digits sit in a box
   * sized once to the widest string, on their own layer, so ticking never reflows or repaints the page.
   */
  #count(from: number, to: number, duration: number): void {
    cancelAnimationFrame(this.#counter);
    if (from === to || !duration || this.#reducedMotion.matches) {
      this.#setReady(to);
      return;
    }
    const { unit, divisor, digits } = byteScale(Math.max(from, to));
    const text = (bytes: number) => (bytes / divisor).toFixed(digits);
    const { readyValue, readyUnit } = this.#elements;
    // Start on the next frame: measuring now would force a layout in the middle of rendering.
    this.#counter = requestAnimationFrame((startedAt) => {
      readyUnit.textContent = unit;
      readyValue.style.width = "";
      readyValue.textContent = text(Math.max(from, to));
      readyValue.style.width = `${readyValue.getBoundingClientRect().width}px`;
      readyValue.classList.add("is-counting");
      let shown = "";
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        if (progress === 1) {
          this.#setReady(to);
          return;
        }
        const next = text(from + (to - from) * progress);
        if (next !== shown) {
          shown = next;
          readyValue.textContent = next;
        }
        this.#counter = requestAnimationFrame(tick);
      };
      tick(startedAt);
    });
  }
}
