export async function authRequest(
  action: string,
  data: Record<string, unknown> = {},
  admin = false,
  signal?: AbortSignal,
) {
  const response = await fetch(admin ? "/api/admin" : "/api/access", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
    signal,
  });
  const body = await response
    .json()
    .catch(() => ({
      error: "The authentication server returned an invalid response.",
    }));
  if (!response.ok) throw new Error(body.error ?? "Authentication failed.");
  return body;
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
