import { createState, createStore } from "dreamland/core";
import { type ThemeId, applyTheme } from "./theme";

export type AvailableTransports = "libcurl" | "epoxy";

export const AVAILABLE_TRANSPORTS: ReadonlyArray<{
  value: AvailableTransports;
  label: string;
}> = [
  { value: "libcurl", label: "Libcurl" },
  { value: "epoxy", label: "Epoxy" },
];
// Wisp is served from the page's own origin in every dev setup, and the page's
// own origin is the one host the browser is guaranteed to be able to reach.
// Exported because /api/wisp-config answers with a relative path ("/wisp/")
// whenever the server has no fixed address to name — see wispConfigUrl() in
// devserver.ts and resolveWispUrl() in index.tsx.
export function sameOriginWispUrl(path = "/wisp/"): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// VITE_WISP_URL is baked into the bundle at build time, which makes it wrong
// the moment the build is served from anywhere but the machine that produced
// it. Two of those ways leave it not merely stale but impossible to connect
// to, and both used to surface only much later — the transports connect
// lazily — as "Wisp WebSocket failed to connect: websocket did not open"
// inside the service worker, on whatever page the user tried to open:
//   - it names loopback while the page is served from another host (the
//     Codespaces/LAN case: the browser's localhost is not the server's);
//   - it is ws:// while the page is https:, which the browser blocks as
//     mixed content before a connection is ever attempted.
// The same-origin URL is the right answer in both, so prefer it there.
function resolveDefaultWispUrl(): string {
  const baked = import.meta.env.VITE_WISP_URL as string | undefined;
  // Server-side rendering / test contexts have no location to derive from.
  if (typeof location === "undefined") return baked || "ws://localhost:4142/";
  if (!baked) return sameOriginWispUrl();

  try {
    const parsed = new URL(baked);
    const unreachableLoopback =
      LOOPBACK_HOSTS.has(parsed.hostname) &&
      !LOOPBACK_HOSTS.has(location.hostname);
    const mixedContent =
      location.protocol === "https:" && parsed.protocol === "ws:";

    return unreachableLoopback || mixedContent ? sameOriginWispUrl() : baked;
  } catch {
    return sameOriginWispUrl();
  }
}

const DEFAULT_WISP_URL = normalizeWispUrl(resolveDefaultWispUrl());
// libcurl-transport's vendored WASM (libcurl.js v0.7.4) ships with no usable
// embedded root CA store -- every single HTTPS request fails with
// "SSL peer certificate ... was not OK" (curl error 60) regardless of
// destination, and libcurl-transport exposes no option to work around it.
// epoxy has the same underlying problem (rustls: InvalidCertificate(
// UnknownIssuer)), but its lower-level client exposes a real
// disable_certificate_validation flag we can wire through (see
// getTransport() in index.tsx and the epoxy-transport patch) -- so it's the
// one that can actually be made to work today.
const DEFAULT_TRANSPORT: AvailableTransports = "epoxy";
const DEFAULT_HOME_URL = "https://google.com";
const DEFAULT_MAX_REQUESTS = 200;

export const demoSettingsStore = createStore(
  {
    transport: DEFAULT_TRANSPORT as AvailableTransports,
    wispUrl: DEFAULT_WISP_URL,
    // Whether wispUrl was typed in by hand in Settings. The environment's own
    // default changes between runs (a new forwarded host, a redeployed tunnel)
    // so a persisted copy of an old one has to be refreshed — but refreshing
    // unconditionally, as this used to, threw away the user's override on the
    // very next load and left the Settings field permanently ineffective.
    wispUrlIsCustom: false,
    homeUrl: DEFAULT_HOME_URL,
    maxRequests: DEFAULT_MAX_REQUESTS,
  },
  {
    ident: "scramjet-demo-settings",
    backing: "localstorage",
    autosave: "auto",
  },
);

if (!demoSettingsStore.wispUrlIsCustom) {
  demoSettingsStore.wispUrl = DEFAULT_WISP_URL;
}

export const appearanceStore = createStore(
  {
    theme: "cyber-green" as ThemeId,
    glassIntensity: 70,
    animationIntensity: 80,
    rgbLighting: true,
    matrixBg: true,
    compactMode: false,
  },
  {
    ident: "scramjet-appearance",
    backing: "localstorage",
    autosave: "auto",
  },
);

// Session-only browser state. This deliberately does not use localStorage.
export const browserSessionState = createState({
  incognito: false,
});

// Live wisp/service-worker connectivity, surfaced by ConnectionStatus and
// updated by the retry/reconnect logic in index.tsx.
export type ConnectionStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";

export const connectionState = createState({
  status: "connecting" as ConnectionStatus,
  attempt: 0,
});

// Apply the saved theme immediately on load.
applyTheme(appearanceStore.theme);

export function normalizeWispUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError("Wisp URL is required.");
  }

  let normalized = trimmed;
  if (!normalized.startsWith("ws://") && !normalized.startsWith("wss://")) {
    normalized = `ws://${normalized}`;
  }

  const parsed = new URL(normalized);
  if (!parsed.pathname || parsed.pathname === "") {
    parsed.pathname = "/";
  }
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  return parsed.toString();
}

export function normalizeHomeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError("Home page URL is required.");
  }

  const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Only HTTP and HTTPS destinations are supported.");
  }
  return parsed.toString();
}

export function normalizeTransport(value: string): AvailableTransports {
  if (AVAILABLE_TRANSPORTS.some((t) => t.value === value)) {
    return value as AvailableTransports;
  }
  throw new TypeError(`Unknown transport: ${value}`);
}

export function normalizeMaxRequests(value: string | number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError("Request log limit must be a number.");
  }

  const rounded = Math.round(parsed);
  if (rounded < 10 || rounded > 5000) {
    throw new RangeError("Request log limit must be between 10 and 5000.");
  }

  return rounded;
}

export const demoSettingsDefaults = {
  wispUrl: DEFAULT_WISP_URL,
  transport: DEFAULT_TRANSPORT,
  homeUrl: normalizeHomeUrl(DEFAULT_HOME_URL),
  maxRequests: DEFAULT_MAX_REQUESTS,
};
