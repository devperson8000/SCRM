export type Bookmarklet = {
  id: string;
  name: string;
  code: string;
};

export function normalizeBookmarkletCode(value: string): string {
  const trimmed = value.trim();
  const code = trimmed.replace(/^javascript\s*:/i, "").trim();
  if (!code) throw new TypeError("Enter JavaScript code for the bookmarklet.");
  return code;
}

export function parseStoredBookmarklets(value: string | null): Bookmarklet[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Bookmarklet =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as Bookmarklet).id === "string" &&
        Boolean((item as Bookmarklet).id.trim()) &&
        typeof (item as Bookmarklet).name === "string" &&
        Boolean((item as Bookmarklet).name.trim()) &&
        typeof (item as Bookmarklet).code === "string" &&
        Boolean((item as Bookmarklet).code.trim()),
    );
  } catch {
    return [];
  }
}

export function runBookmarklet(target: Window, value: string): void {
  target.eval(normalizeBookmarkletCode(value));
}
