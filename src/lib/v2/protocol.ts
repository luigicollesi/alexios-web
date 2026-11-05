// Shared input validators. No database or runtime dependencies.
export function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(value);
}

export function isValidRunId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isValidCommandCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
}
