export function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function formatTable(
  rows: Record<string, unknown>[],
  columns?: string[]
): string {
  if (rows.length === 0) return "(no results)";

  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...rows.map((r) => String(r[c] ?? "").length)
    )
  );

  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((r) =>
      cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  ")
    )
    .join("\n");

  return `${header}\n${separator}\n${body}`;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function outputResult(
  data: unknown,
  opts: { json?: boolean }
): void {
  if (opts.json) {
    console.log(formatJson(data));
  } else if (Array.isArray(data)) {
    console.log(formatTable(data as Record<string, unknown>[]));
  } else {
    console.log(formatJson(data));
  }
}
