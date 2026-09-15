export const WISP_INIT_MAX_ATTEMPTS = 12;

const WISP_INIT_BASE_DELAY_MS = 1_000;
const WISP_INIT_MAX_DELAY_MS = 10_000;

export function wispInitRetryDelayMs(
  attempt: number,
  randomValue = Math.random(),
): number {
  const exponential = Math.min(
    WISP_INIT_BASE_DELAY_MS * 2 ** attempt,
    WISP_INIT_MAX_DELAY_MS,
  );
  // Keep enough jitter to avoid a thundering herd while guaranteeing that
  // the full retry sequence spans Render's roughly one-minute cold start.
  return exponential * (0.75 + randomValue * 0.25);
}
