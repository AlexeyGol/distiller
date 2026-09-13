/**
 * Dates are formatted on the server with a fixed locale and UTC.
 *
 * Letting the browser format them re-introduces the classic hydration
 * mismatch: the server renders in the container timezone and the client in the
 * viewer one, and React throws away the markup. A self-hosted digest tool can
 * live with UTC being explicit.
 */
const STAMP = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatStamp(value: Date | null | undefined): string {
  if (!value) return "never";
  return `${STAMP.format(value)} UTC`;
}

export function formatDay(value: Date | null | undefined): string {
  if (!value) return "-";
  return value.toISOString().slice(0, 10);
}

export function excerpt(text: string | null | undefined, max = 180): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
