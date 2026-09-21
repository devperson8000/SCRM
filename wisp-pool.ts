export function nextWispServerIndex(
  previousValue: string | null,
  poolSize: number,
): number {
  if (!Number.isInteger(poolSize) || poolSize < 1) return 0;

  if (previousValue === null) return 0;
  const previous = Number(previousValue);
  if (!Number.isInteger(previous) || previous < 0 || previous >= poolSize) {
    return 0;
  }

  return (previous + 1) % poolSize;
}

export function selectWispServerUrl(
  urls: readonly string[],
  requestedIndex: unknown,
): string {
  if (urls.length === 0) {
    throw new Error("At least one Wisp server URL is required.");
  }

  const parsed =
    typeof requestedIndex === "string" ? Number(requestedIndex) : Number.NaN;
  const index =
    Number.isInteger(parsed) && parsed >= 0 ? parsed % urls.length : 0;

  return urls[index];
}
