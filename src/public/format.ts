// Pure display formatting. No DOM access, so it can be unit tested.

const DAY_MS = 86_400_000;
const units = ["B", "KB", "MB", "GB", "TB"] as const;
export type ByteUnit = (typeof units)[number];

/** The unit and precision a value is shown in: three significant figures, 512 MB, 4.98 GB, 14.2 GB. */
export function byteScale(bytes: number): { unit: ByteUnit; divisor: number; digits: number } {
  let index = 0;
  while (bytes >= 1024 ** (index + 1) && index < units.length - 1) index += 1;
  const value = bytes / 1024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  // 1023.6 KB rounds to "1024 KB"; show it as 1 MB instead.
  if (Number(value.toFixed(digits)) >= 1024 && index < units.length - 1) index += 1;
  const scaled = bytes / 1024 ** index;
  return {
    unit: units[index] ?? "B",
    divisor: 1024 ** index,
    digits: index === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2,
  };
}

export function byteParts(bytes: number): [value: string, unit: ByteUnit] {
  const { unit, divisor, digits } = byteScale(bytes);
  return [String(Number((bytes / divisor).toFixed(digits))), unit];
}

export const formatBytes = (bytes: number): string => byteParts(bytes).join(" ");

export const daysSince = (time: number, now = Date.now()): number => Math.floor(Math.max(0, now - time) / DAY_MS);

export function age(time: number | null, now = Date.now()): string {
  if (time === null) return "Unknown";
  const days = daysSince(time, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
export const formatDate = (time: number): string => dateFormat.format(time);

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const formatTime = (time: number): string => timeFormat.format(time);

export const plural = (count: number, noun: string, nouns = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : nouns}`;

export const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Safe in text and in quoted attributes, unlike reading back `textContent` as `innerHTML`, which leaves quotes. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => entities[character] ?? "");
