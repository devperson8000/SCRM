export async function authRequest(
  action: string,
  data: Record<string, unknown> = {},
  admin = false,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "The face check timed out. Please retry.",
          "TimeoutError",
        ),
      ),
    55_000,
  );
  try {
    const response = await fetch(admin ? "/api/admin" : "/api/access", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
      signal: controller.signal,
    });
    const body = await response
      .json()
      .catch(() => ({
        error:
          response.status === 413
            ? "The camera upload was too large. Reload the page and retry."
            : "The authentication service returned an invalid response. Please retry.",
      }));
    if (!response.ok) throw new Error(body.error ?? "Authentication failed.");
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function button(text: string, action: () => void) {
  const b = el("button", text, "face-button");
  b.type = "button";
  b.onclick = action;
  return b;
}
