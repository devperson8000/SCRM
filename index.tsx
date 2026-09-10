import LoadInterstitial from "./components/LoadInterstitial";
import App from "./App";
// Type-only: the transport implementations are loaded on demand in
// getTransport(). Only ever one of the two is used in a session — the choice is
// a runtime setting — but importing both at module scope put both of their WASM
// wrappers in the main chunk, so every visitor downloaded and parsed the
// transport they had not selected before the UI could paint.
import type LibcurlClient from "@mercuryworkshop/libcurl-transport";
import type EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfig } from "@mercuryworkshop/scramjet";
import { appScramjetFlags } from "./scramjet-flags";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import {
  HttpCachePlugin,
  LanguagePlugin,
} from "@mercuryworkshop/scramjet-utils";
import { connectionState, demoSettingsStore, sameOriginWispUrl } from "./store";

// Captured before the interceptor further down replaces console.error, so the
// recovery paths can report their own failures without the interceptor reading
// that report back as another reason to recover.
const nativeConsoleError = console.error.bind(console);

// ---- transport recovery ---------------------------------------------------
// Three independent things ask for a fresh transport: an epoxy WASM panic, a
// dead wisp tunnel reported through console.error, and the network coming back
// after a drop. They routinely fire together — a tunnel that dies takes the
// network event and a burst of per-request errors with it — and each used to
// build its own transport.
//
// That was worse than redundant. Controller.setTransport() only reassigns a
// reference; it has no teardown, and neither transport client exposes a close()
// (see @mercuryworkshop/epoxy-transport and libcurl-transport), so every
// replaced transport leaves its wisp WebSocket open until the server times it
// out. Concurrent swaps therefore leaked a socket each and raced to decide
// which one the controller ended up holding.
//
// One in-flight swap at a time, with a cooldown between them, keeps that to a
// single socket per genuine failure. Callers await the same promise.
const TRANSPORT_SWAP_COOLDOWN_MS = 5000;
let swapInFlight: Promise<boolean> | null = null;
let lastSwapAt = 0;

/**
 * Resolves true once the controller is holding a working transport, false if
 * the rebuild failed. Exported so Settings goes through the same single-flight
 * path as the automatic recovery: applying a new transport or wisp URL by hand
 * used to build one directly, which could run concurrently with a recovery
 * already in progress and leak the loser's WebSocket — the exact race this
 * function exists to prevent.
 */
export function swapTransport(
  reason: string,
  options: { probe?: boolean } = {},
): Promise<boolean> {
  if (swapInFlight) return swapInFlight;
  if (!controller) return Promise.resolve(false);

  // Trailing edge, not leading: a request arriving inside the cooldown waits
  // it out rather than being dropped. The old throttle discarded those, so a
  // failure that happened to land 4s after an unsuccessful recovery was simply
  // never acted on and the session stayed dead until the user reloaded.
  const wait = Math.max(
    0,
    lastSwapAt + TRANSPORT_SWAP_COOLDOWN_MS - Date.now(),
  );

  console.warn(
    `[scramjet] rebuilding transport — ${reason}${wait ? ` (in ${Math.round(wait / 1000)}s)` : ""}`,
  );
  connectionState.status = "reconnecting";
  swapInFlight = (async () => {
    try {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      controller.setTransport(await getTransport(options));
      connectionState.status = "online";

      return true;
    } catch (error) {
      // Previously each of these rejections escaped into a floating promise:
      // the status stuck on "reconnecting" forever and the reason was never
      // reported. Logged through the native console.error so a failure to
      // recover can never be read back by the interceptor below as another
      // reason to recover.
      nativeConsoleError(
        `[scramjet] transport rebuild failed (${reason}):`,
        error,
      );
      connectionState.status = "offline";

      return false;
    } finally {
      // Timed from completion, not from the request: a swap that takes eight
      // seconds to fail should not be immediately retryable.
      lastSwapAt = Date.now();
      swapInFlight = null;
    }
  })();

  return swapInFlight;
}

// Catch epoxy-transport WASM panics ("closure invoked recursively or after
// being dropped"), which happen when the WebSocket connection to the wisp
// server fails uncleanly. This used to fall back to libcurl, but
// libcurl-transport's vendored WASM has no usable embedded CA store and
// fails every HTTPS request outright (see store.ts) -- swapping to it on a
// transient epoxy hiccup would trade a recoverable panic for a permanent
// failure. Recreate a fresh epoxy transport instead.
window.addEventListener("error", (event) => {
  const details = `${event.message} ${event.error instanceof Error ? event.error.message : ""}`;
  if (!details.includes("closure invoked recursively or after being dropped"))
    return;
  event.preventDefault();
  void swapTransport("epoxy transport WASM panic");
});

// The wisp websocket has a hard ceiling on how long it can stay open (e.g.
// Vercel's WebSocket functions cap a connection at 5 minutes) — when it dies
// mid-session, libcurl/epoxy report it as a "Wisp: MuxTaskEnded" hyper-client
// error on every subsequent request, and nothing else notices or recovers.
// Watch for that signature and recreate the transport; the swap is throttled
// so a burst of failed requests (which all log this at once) only triggers one.
//
// The second half of this covers a failure that is not a *dead* tunnel but one
// that never opened. The wisp URL carries a token that expires 60 seconds
// after it is minted, while both transports connect lazily and reuse the URL
// they were constructed with for every reconnect — so a transport built at
// page load and first used a few minutes later presents a token the server has
// already rejected, and stays broken forever because nothing re-mints it.
// Recreating the transport resolves a fresh URL, which is also the right move
// when the wisp server simply happened to be down at that moment.
const RECOVERABLE_TRANSPORT_ERROR =
  /Wisp:\s*MuxTaskEnded|Multiplexor task ended|WebSocketConnectFailed|websocket did not open|Wisp WebSocket failed to connect/i;
console.error = (...args: unknown[]) => {
  nativeConsoleError(...args);
  if (
    args.some(
      (arg) => typeof arg === "string" && RECOVERABLE_TRANSPORT_ERROR.test(arg),
    ) ||
    args.some(
      (arg) =>
        arg instanceof Error && RECOVERABLE_TRANSPORT_ERROR.test(arg.message),
    )
  ) {
    void swapTransport("wisp tunnel is not usable", { probe: true });
  }
};

window.addEventListener("offline", () => {
  connectionState.status = "offline";
});
window.addEventListener("online", () => {
  if (connectionState.status !== "offline") return;
  // The wisp websocket doesn't recover on its own after the underlying
  // network drops (e.g. laptop sleep, wifi handoff, a Vercel WebSocket
  // function hitting its max duration) — hand the controller a fresh
  // transport so subsequent requests actually go somewhere.
  //
  // The probe matters here in particular: the "online" event only means the OS
  // has a route again, not that the wisp server is reachable, so claiming
  // online without it would be a guess.
  void swapTransport("network returned", { probe: true });
});

let app = document.getElementById("app")!;

const ACCESS_SESSION_KEY = "scramjet-access-session";

let controller: InstanceType<typeof Controller>;
const cachePlugin = new HttpCachePlugin();
const languagePlugin = new LanguagePlugin();

async function showAccessGate(): Promise<void> {
  // sessionStorage is isolated per tab: reloads remain unlocked, while
  // opening the proxy in a new tab/window starts at the gate again.
  if (sessionStorage.getItem(ACCESS_SESSION_KEY) === "granted") {
    const status = await fetch("/api/access", {
      credentials: "same-origin",
      cache: "no-store",
    }).catch(() => null);
    const access = status
      ? ((await status.json().catch(() => null)) as {
          unlocked?: boolean;
        } | null)
      : null;
    if (status?.ok && access?.unlocked) return;
    sessionStorage.removeItem(ACCESS_SESSION_KEY);
  }

  app.innerHTML = "";
  const gate = document.createElement("main");
  gate.className = "access-gate";
  gate.setAttribute("role", "main");

  const card = document.createElement("section");
  card.className = "access-card";
  card.setAttribute("aria-labelledby", "access-title");

  const brand = document.createElement("div");
  brand.className = "access-brand";
  const mark = document.createElement("span");
  mark.className = "access-brand-mark";
  mark.setAttribute("aria-hidden", "true");
  brand.append(mark, document.createTextNode("Secure workspace"));

  const title = document.createElement("h1");
  title.id = "access-title";
  title.textContent = "Private access";

  const description = document.createElement("p");
  description.textContent =
    "Enter the workspace passcode to continue. Your session stays local to this browser.";

  const form = document.createElement("form");
  form.className = "access-form";
  const label = document.createElement("label");
  label.htmlFor = "access-password";
  label.textContent = "Workspace passcode";
  const input = document.createElement("input");
  input.id = "access-password";
  input.className = "access-input";
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 64;
  input.required = true;
  input.placeholder = "Enter passcode";
  const submit = document.createElement("button");
  submit.className = "access-submit";
  submit.type = "submit";
  submit.textContent = "Unlock workspace";
  const message = document.createElement("div");
  message.className = "access-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const footnote = document.createElement("p");
  footnote.className = "access-footnote";
  footnote.textContent =
    "Protected session · No credentials are stored in the page.";

  form.append(label, input, submit, message);
  card.append(brand, title, description, form, footnote);
  gate.append(card);
  app.append(gate);
  input.focus();

  await new Promise<void>((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!input.value || submit.disabled) return;
      submit.disabled = true;
      submit.textContent = "Checking access…";
      message.textContent = "";
      try {
        const response = await fetch("/api/access", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.value }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          // Only a 401 is actually a wrong passcode. Reporting every failed
          // response as one is how a misconfigured deployment came to look
          // like a forgotten password: a Vercel Function that throws at cold
          // start (a missing SESSION_SECRET does exactly that) answers 500
          // with an HTML body, so the .json() above yields null and the old
          // fallback text blamed the passcode — sending people to hunt for a
          // credential that was correct all along.
          message.textContent =
            body?.error ||
            (response.status === 401
              ? "Access denied. Check the passcode."
              : `The access service failed (HTTP ${response.status}). ` +
                "That's a server problem, not your passcode.");
          input.select();
          submit.disabled = false;
          submit.textContent = "Unlock workspace";
          return;
        }
        input.value = "";
        sessionStorage.setItem(ACCESS_SESSION_KEY, "granted");
        gate.remove();
        resolve();
      } catch {
        message.textContent =
          "The access service is unavailable. Try again shortly.";
        submit.disabled = false;
        submit.textContent = "Unlock workspace";
      }
    });
  });
}

// If the user has manually overridden the wisp URL in Settings, honor it
// verbatim (this is how local dev / self-hosted wisp servers keep working).
// Otherwise fetch a short-lived, token-authorized URL for the standalone
// always-on wisp server (see wisp-server.ts + api/wisp-config.ts) — the
// token is minted per-connection and expires after 60s, so it can't be
// replayed later even if it leaks via logs or devtools.
async function resolveWispUrl(): Promise<string> {
  if (demoSettingsStore.wispUrlIsCustom) {
    return demoSettingsStore.wispUrl;
  }
  try {
    const response = await fetch("/api/wisp-config", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      // Carry the server's own explanation up to init()'s error screen. A
      // bare "wisp-config 503" told the user only that a number came back;
      // the response body names the env var that isn't set.
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error || `wisp-config ${response.status}`);
    }
    const { wispUrl, token } = (await response.json()) as {
      wispUrl: string;
      token: string;
    };
    // A relative wispUrl ("/wisp/") is the server saying "same origin as this
    // page" — which is all it can honestly say when wisp rides on its own
    // port and a tunnel sits in between (see wispConfigUrl() in devserver.ts).
    // Resolving it here is the whole point: only the browser knows the host
    // and scheme it actually loaded the page from. An absolute URL is used
    // verbatim — in production it names a standalone host that has nothing to
    // do with this origin, so "repairing" it would just aim the transport at
    // an address that doesn't exist.
    const base = wispUrl.startsWith("/") ? sameOriginWispUrl(wispUrl) : wispUrl;
    // The wisp client requires the URL string itself to end with a trailing
    // slash, which rules out a "?token=" query string — the wisp server
    // reads the token from this path segment instead (see wisp-server.ts).
    return `${base}${encodeURIComponent(token)}/`;
  } catch (error) {
    const isLocalDev = ["localhost", "127.0.0.1"].includes(location.hostname);
    if (isLocalDev) {
      // devserver.ts answers /api/wisp-config too, so reaching here means it
      // is genuinely unreachable — but on localhost the dev server's own
      // same-origin /wisp/ handler is a real endpoint, which is exactly what
      // the default wispUrl points at. Deliberately not broadened to other
      // hostnames: in production the same-origin /wisp/ does not exist (the
      // tunnel moved to a standalone host), so "falling back" there means
      // handing the transport an address that hangs instead of failing.
      return demoSettingsStore.wispUrl;
    }
    // In production there's no same-origin /wisp/ to fall back to anymore
    // (the wisp tunnel moved to a standalone Railway host) — silently
    // falling back here used to hand the transport a URL that doesn't
    // exist, which just hangs forever instead of failing. Surface the
    // error so init()'s retry/backoff can react instead.
    throw error;
  }
}

// Constructing a transport never opens the wisp websocket: epoxy and libcurl
// both connect lazily, on the first proxied request, from inside the service
// worker. A wisp URL that can never connect therefore sails through init()
// and only shows up much later as an opaque "Internal Service Worker Error:
// ... websocket did not open" on whatever page the user tried to visit.
// Opening it once here moves that failure back into init(), where the
// retry/backoff can act on it and the message can say what actually broke.
const WISP_PROBE_TIMEOUT_MS = 8000;

function probeWispUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // A ws:// socket from an https page is blocked before a single byte
    // leaves the browser, and Chrome reports that as a bare error event —
    // indistinguishable from "the server is down", with an empty server log
    // to match. Name it, because the fix (serve wisp over wss://) is nothing
    // like the fix for an unreachable host.
    if (
      typeof location !== "undefined" &&
      location.protocol === "https:" &&
      url.startsWith("ws://")
    ) {
      reject(
        new Error(
          "an https page cannot open a ws:// socket (blocked as mixed content)",
        ),
      );

      return;
    }

    let socket: WebSocket;
    try {
      // Mixed content (a ws:// URL on an https page) and malformed URLs throw
      // here rather than surfacing as an event.
      socket = new WebSocket(url);
    } catch (error) {
      reject(error);

      return;
    }

    const settle = (error?: Error) => {
      clearTimeout(timer);
      socket.onopen = socket.onerror = socket.onclose = null;
      // This connection only ever answered "can it open"; the transport opens
      // its own, so close it rather than leaving it to idle out server-side.
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        settle(
          new Error(`wisp did not respond within ${WISP_PROBE_TIMEOUT_MS}ms`),
        ),
      WISP_PROBE_TIMEOUT_MS,
    );

    socket.onopen = () => settle();
    socket.onerror = () => settle(new Error("wisp connection failed"));
    // A rejected upgrade (401 from an expired token, 429, 404) reaches the
    // browser as a close without an open, and does not always fire onerror.
    socket.onclose = () =>
      settle(new Error("wisp closed the connection before it opened"));
  });
}

export async function getTransport(
  options: { probe?: boolean } = {},
): Promise<LibcurlClient | EpoxyClient> {
  const wispUrl = await resolveWispUrl();
  if (options.probe) {
    try {
      await probeWispUrl(wispUrl);
    } catch (error) {
      // Name the URL: the difference between a wrong host and a rejected
      // token is the entire diagnosis, and it is invisible otherwise.
      throw new Error(
        `Cannot reach the wisp server at ${wispUrl} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  switch (demoSettingsStore.transport) {
    case "epoxy": {
      const { default: Epoxy } = await import(
        "@mercuryworkshop/epoxy-transport"
      );

      return new Epoxy({
        wisp: wispUrl,
        // The vendored epoxy WASM's embedded root CA store doesn't validate
        // real-world certificate chains (every destination fails with
        // rustls's InvalidCertificate(UnknownIssuer), a defect in the
        // upstream binary this project can't rebuild) -- without this the
        // proxy cannot load any HTTPS site at all. The TLS connection is
        // still genuinely end-to-end encrypted between the browser and the
        // destination; this only removes certificate *chain validation*,
        // narrowing (not eliminating) protection to an active MITM
        // specifically on the wisp server's own network path.
        disable_certificate_validation: true,
      });
    }
    case "libcurl":
    default: {
      const { default: Libcurl } = await import(
        "@mercuryworkshop/libcurl-transport"
      );

      return new Libcurl({ wisp: wispUrl });
    }
  }
}

async function waitForControllerOrReady(timeoutMs = 10000): Promise<void> {
  if (navigator.serviceWorker.controller) return;

  // Both the listener and the timer used to outlive the race: init() retries up
  // to four times, so a slow first attempt left a "controllerchange" listener
  // and a live 10s timer behind on each pass.
  let onChange!: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const ready = navigator.serviceWorker.ready.then(() => {});
  const controllerChanged = new Promise<void>((resolve) => {
    onChange = () => resolve();
    navigator.serviceWorker.addEventListener("controllerchange", onChange, {
      once: true,
    });
  });
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    // Whichever happens first; on timeout we continue rather than block the UI.
    await Promise.race([ready, controllerChanged, timeout]);
  } finally {
    clearTimeout(timer!);
    navigator.serviceWorker.removeEventListener("controllerchange", onChange);
  }
}

// Transient failures (a wisp connection that hasn't come up yet, a service
// worker install racing the page load, a network blip) shouldn't dump the
// user straight to a manual "reload the page" screen. Retry with backoff
// before giving up.
async function attemptInitOnce(interstitial: any) {
  const registration = await navigator.serviceWorker.register("./sw.js");

  // Non-blocking progress updates on state transitions.
  const updateStatus = (sw: ServiceWorker | null) => {
    if (!sw) return;
    const set = (msg: string) => (interstitial.$.state.status = msg);
    const apply = () => {
      switch (sw.state) {
        case "installing":
          set("Installing service worker...");
          break;
        case "installed":
          set("Service worker installed, waiting to activate...");
          break;
        case "activating":
          set("Activating service worker...");
          break;
        case "activated":
          set("Service worker activated");
          break;
        case "redundant":
          set("Service worker became redundant");
          break;
      }
    };
    apply();
    sw.addEventListener("statechange", apply);
  };

  updateStatus(registration.installing ?? registration.waiting ?? null);

  // Wait for control or readiness with a timeout; don't hang the UI on updates.
  interstitial.$.state.status = "Waiting for service worker to take control...";
  await waitForControllerOrReady(10000);
  interstitial.$.state.status =
    "Service worker ready, waiting for controller init";
  const readySw = navigator.serviceWorker.controller ?? registration.active;
  if (!readySw) {
    throw new Error("No service worker available for controller");
  }
  interstitial.$.state.status = "Connecting to the wisp server...";
  controller = new Controller({
    serviceworker: readySw,
    transport: await getTransport({ probe: true }),
    // See scramjet-flags.ts: this is the production flag set, not
    // defaultConfigDev. The dev profile injects an error-capture call into
    // every catch block, compiles a Function trampoline per proxied property
    // per realm, and re-decodes every script to append a sourceURL comment —
    // all of which this pays for on every page a user loads.
    scramjetConfig: {
      ...defaultConfig,
      flags: { ...appScramjetFlags },
    },
  });
  await controller.wait();
  console.log(controller);
  interstitial.$.state.status = "Controller initialized";
  interstitial.close();
}

const INIT_MAX_ATTEMPTS = 4;
const INIT_BASE_DELAY_MS = 600;

async function init() {
  const interstitial: any = (
    <LoadInterstitial status={"Loading"}></LoadInterstitial>
  );
  document.body.append(interstitial);
  interstitial.showModal();

  let lastError: unknown;
  for (let attempt = 0; attempt < INIT_MAX_ATTEMPTS; attempt++) {
    connectionState.status = attempt === 0 ? "connecting" : "reconnecting";
    connectionState.attempt = attempt;
    try {
      await attemptInitOnce(interstitial);
      connectionState.status = "online";
      connectionState.attempt = 0;
      return;
    } catch (e) {
      lastError = e;
      console.warn(
        `[scramjet] init attempt ${attempt + 1}/${INIT_MAX_ATTEMPTS} failed:`,
        e,
      );
      if (attempt < INIT_MAX_ATTEMPTS - 1) {
        // Equal jitter: half the exponential delay is fixed, half is
        // randomized. If the shared wisp server restarts, every connected
        // browser hits this retry loop at roughly the same moment — pure
        // exponential backoff would have them all retry in lockstep and
        // hammer the server right as it comes back up.
        const exponential = INIT_BASE_DELAY_MS * 2 ** attempt;
        const delay = exponential / 2 + Math.random() * (exponential / 2);
        interstitial.$.state.status = `Connection issue, retrying in ${Math.round(delay / 1000)}s...`;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  connectionState.status = "offline";
  console.error("Error during service worker registration:", lastError);
  // Always close the modal on error to prevent hanging UI.
  try {
    interstitial.close();
  } catch {}
  app.innerHTML = "";
  const recovery = document.createElement("main");
  recovery.className = "startup-error";
  recovery.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = "Scramjet could not start";
  const message = document.createElement("p");
  message.textContent =
    "The browser engine did not initialize. Reload the page to try again.";
  // The cause is almost always an unreachable wisp server, and without it the
  // screen is unactionable — the user can't tell a wrong URL from a server
  // that's simply down, and neither can anyone they report it to.
  const detail = document.createElement("p");
  detail.className = "startup-error-detail";
  detail.textContent =
    lastError instanceof Error ? lastError.message : String(lastError);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  button.addEventListener("click", () => window.location.reload());
  recovery.append(title, message, detail, button);
  app.append(recovery);
}

async function mount() {
  try {
    if (!controller) return;
    const root = <App />;
    app.replaceWith(root);
  } catch (e) {
    console.error(e);
    app.innerHTML = "";
    const recovery = document.createElement("main");
    recovery.className = "startup-error";
    recovery.setAttribute("role", "alert");
    const title = document.createElement("h1");
    title.textContent = "The browser interface could not load";
    const message = document.createElement("p");
    message.textContent = "Reload the page to recover the proxy interface.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reload";
    button.addEventListener("click", () => window.location.reload());
    recovery.append(title, message, button);
    app.append(recovery);
  }
}

async function start() {
  await showAccessGate();
  await init();
  await mount();
}

void start();
export { controller, cachePlugin, languagePlugin };
