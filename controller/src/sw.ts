/// <reference lib="WebWorker" />
/// <reference types="@types/serviceworker" />
import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Controllerbound, SWbound } from "./types";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { DEFAULT_PREFIX } from "./defaults";

function makeId(): string {
  return Math.random().toString(36).substring(2, 10);
}

const cookieResolvers: Record<string, (value: void) => void> = {};
addEventListener("message", (e) => {
  if (!e.data) return;
  if (typeof e.data != "object") return;
  if (e.data.$sw$setCookieDone && typeof e.data.$sw$setCookieDone == "object") {
    const done = e.data.$sw$setCookieDone;

    const resolver = cookieResolvers[done.id];
    if (resolver) {
      resolver();
      delete cookieResolvers[done.id];
    }
  }

  if (e.data.$sw$ping && typeof e.data.$sw$ping == "object") {
    // A client checking whether this worker still holds its MessagePort.
    // Delivering the message is what restarts a stopped worker, so by the time
    // we answer, `tabs` is either intact or empty — and empty is the client's
    // cue to hand over a new port, while the user is still only looking at the
    // tab rather than waiting on a click.
    announceRevive(e.source as Client | null);

    return;
  }

  if (
    e.data.$sw$initRemoteTransport &&
    typeof e.data.$sw$initRemoteTransport == "object"
  ) {
    const { port, prefix } = e.data.$sw$initRemoteTransport;
    const pathname = new URL(prefix).pathname;

    // Same restart problem as route(): a proxied page whose websocket outlives
    // the worker sends its transport port to whichever instance is running
    // now, which may have been spawned by this very message and know nothing.
    // Reviving is worth a wait here too — dropping the port leaves that page
    // with a websocket that silently never connects.
    void awaitController(pathname).then((relevantcontroller) => {
      if (!relevantcontroller) {
        console.error("No relevant controller found for transport init");

        return;
      }
      relevantcontroller.rpc.call("initRemoteTransport", port, [port]);
    });
  }
});

const tabs: ControllerReference[] = [];

// A service worker keeps nothing across a restart, and the browser restarts it
// aggressively: Chrome stops an idle worker after roughly 30 seconds, which a
// backgrounded tab reaches almost immediately. Everything below exists because
// the restarted instance is handed a fetch event for a proxied URL *before* any
// client has had the chance to tell it that URL is proxied.
//
// PREFIX_ROOTS is the part of that knowledge the worker can hold statically:
// what a proxied path looks like, as opposed to which controller owns it. It is
// seeded with the package default so a cold instance recognises one on its very
// first fetch event, and each controller adds its own root on attach — enough
// for the rest of that instance's life, though a deployment that overrides
// `config.prefix` is back to the default for the one request that restarts the
// worker, since a Set does not survive termination either.
const PREFIX_ROOTS = new Set<string>([DEFAULT_PREFIX]);

function findTab(pathname: string): ControllerReference | undefined {
  return tabs.find((tab) => pathname.startsWith(tab.prefix));
}

function isProxiedPath(pathname: string): boolean {
  for (const root of PREFIX_ROOTS) {
    if (pathname.startsWith(root)) return true;
  }

  return false;
}

type PendingController = {
  pathname: string;
  settle: (tab: ControllerReference | undefined) => void;
};
const pendingControllers = new Set<PendingController>();

async function broadcastRevive() {
  announceRevive(...(await clients.matchAll()));
}

/**
 * Tells clients which controllers this worker is currently holding a port for.
 * A client whose id is missing takes it as a request to hand over a new one;
 * one whose id is present leaves its channel alone, which matters because
 * tearing down a live port also strands every request in flight on it.
 */
function announceRevive(...targets: (Client | null)[]) {
  const knownIds = tabs.map((tab) => tab.id);
  for (const target of targets) {
    target?.postMessage({
      $controller$swrevive: { knownIds },
    });
  }
}

// Long enough to cover a throttled background tab waking up and rebuilding its
// port, short enough that a genuinely absent controller (the last tab was
// closed, and only a stray prefetch is still firing) fails instead of hanging.
const CONTROLLER_REVIVE_TIMEOUT_MS = 10000;
const CONTROLLER_REVIVE_RETRY_MS = 1000;

/**
 * Resolves with the controller that owns `pathname`, asking every client to
 * hand over a fresh MessagePort if none is attached yet. Resolves undefined if
 * nobody claims the path in time.
 */
function awaitController(
  pathname: string,
): Promise<ControllerReference | undefined> {
  const attached = findTab(pathname);
  if (attached) return Promise.resolve(attached);

  return new Promise((resolve) => {
    const pending: PendingController = {
      pathname,
      settle: (tab) => {
        pendingControllers.delete(pending);
        clearTimeout(timer);
        clearInterval(retry);
        resolve(tab);
      },
    };
    const timer = setTimeout(
      () => pending.settle(undefined),
      CONTROLLER_REVIVE_TIMEOUT_MS,
    );
    // The revive is broadcast repeatedly, not once: the page that owns this
    // prefix may still be waking from a throttled background state, and a
    // postMessage delivered before its listener is live is simply dropped.
    // Repeats are safe because each one names the controllers already
    // attached, so a client that has answered ignores the rest.
    const retry = setInterval(
      () => void broadcastRevive(),
      CONTROLLER_REVIVE_RETRY_MS,
    );

    pendingControllers.add(pending);
    void broadcastRevive();
  });
}

class ControllerReference {
  rpc: RpcHelper<SWbound, Controllerbound>;

  constructor(
    public prefix: string,
    public id: string,
    port: MessagePort,
  ) {
    this.rpc = new RpcHelper(
      {
        sendSetCookie: async ({ cookies, options }) => {
          const clients = await self.clients.matchAll();
          const ids: string[] = [];
          const promises: Promise<string>[] = [];

          // Navigation fetches (document/iframe) deliver cookies via the inject
          // script's embedded cookieJar dump — the destination page doesn't have
          // inject.ts loaded yet to ack, so awaiting would deadlock. Broadcast
          // so any already-loaded clients can update their jars, but don't wait.
          const isNavigation =
            options?.destination === "document" ||
            options?.destination === "iframe";

          for (const client of clients) {
            const id = makeId();
            ids.push(id);
            client.postMessage({
              $controller$setCookie: {
                cookies,
                options,
                id,
              },
            });
            if (!isNavigation) {
              promises.push(
                new Promise<string>((resolve) => {
                  // Resolve with the id so we know which client replied.
                  cookieResolvers[id] = () => resolve(id);
                }),
              );
            }
          }
          // Wait for the first client to acknowledge the cookie sync.
          // Using Promise.any (not Promise.all) so that extra SW clients created by
          // window.open (e.g. test popup windows) don't cause timeouts — only the
          // main controller client needs to respond.
          if (promises.length > 0) {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            let responded = false;
            const timeoutPromise = new Promise<void>((resolve) => {
              timeoutId = setTimeout(() => {
                if (!responded) {
                  const pending = ids.filter(
                    (id) => cookieResolvers[id] !== undefined,
                  );
                  console.error(
                    "timed out waiting for set cookie response (deadlock?): " +
                      `cookies=${cookies.length} clients=${clients.length} ` +
                      `pending=${pending.length}/${ids.length} ` +
                      `clientUrls=${clients.map((c) => c.url).join(",")}`,
                  );
                }
                resolve();
              }, 1000);
            });

            try {
              await Promise.race([
                timeoutPromise,
                Promise.any(promises)
                  .then(() => {
                    responded = true;
                  })
                  .catch(() => {}),
              ]);
            } finally {
              // Clear the timeout so it doesn't fire spuriously after the
              // race has already been won by Promise.any.
              if (timeoutId !== undefined) clearTimeout(timeoutId);
              // Clean up any pending resolvers so clients that never
              // responded don't leak entries in cookieResolvers.
              for (const id of ids) {
                delete cookieResolvers[id];
              }
            }
          }
        },
      },
      "tabchannel-" + id,
      (data, transfer) => {
        port.postMessage(data, transfer);
      },
    );
    port.onmessage = (e: MessageEvent) => {
      this.rpc.recieve(e.data);
    };
    port.onmessageerror = console.error;

    this.rpc.call("ready", undefined);
  }
}

addEventListener("message", (e) => {
  if (!e.data) return;
  if (typeof e.data != "object") return;
  if (!e.data.$controller$init) return;
  if (typeof e.data.$controller$init != "object") return;
  const init = e.data.$controller$init;

  // Sent so a restarted worker can recognise a proxied path before any
  // controller has attached; older controllers don't send it, in which case
  // the default seeded into PREFIX_ROOTS is all there is to go on.
  if (typeof init.prefixRoot === "string" && init.prefixRoot) {
    PREFIX_ROOTS.add(init.prefixRoot);
  }

  const existing = tabs.findIndex((t) => t.id === init.id);
  if (existing !== -1) {
    tabs.splice(existing, 1);
  }
  const tab = new ControllerReference(init.prefix, init.id, e.ports[0]);
  tabs.push(tab);

  // Requests that arrived before this port existed — the ones that restarted
  // the worker in the first place — are parked in awaitController().
  for (const pending of [...pendingControllers]) {
    if (pending.pathname.startsWith(tab.prefix)) {
      pending.settle(tab);
    }
  }
});

export function shouldRoute(event: FetchEvent): boolean {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return false;

  // Claiming the path when no controller is attached is deliberate. This
  // worker may have been started by this very request, in which case `tabs` is
  // empty for reasons that have nothing to do with whether the URL is ours —
  // and declining sends a proxied request to the app's own origin, where it
  // gets the SPA shell back and the page the user just clicked to breaks.
  // route() waits for a controller instead.
  return findTab(url.pathname) !== undefined || isProxiedPath(url.pathname);
}

export async function route(event: FetchEvent): Promise<Response> {
  try {
    const url = new URL(event.request.url);
    const tab = await awaitController(url.pathname);
    if (!tab) {
      // No client claimed the prefix within the timeout: every tab that could
      // answer for it is gone or wedged. A body the user can read beats the
      // TypeError that reaching into an empty registry used to produce.
      return new Response(
        `No scramjet controller is attached for ${url.pathname}. ` +
          "Reload the page to reconnect the proxy.",
        {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        },
      );
    }
    const client = await clients.get(event.clientId);

    const rawheaders: RawHeaders = [...event.request.headers];

    const response = await tab.rpc.call(
      "request",
      {
        rawUrl: event.request.url,
        rawReferrer: event.request.referrer,
        destination: event.request.destination,
        mode: event.request.mode,
        referrer: event.request.referrer,
        method: event.request.method,
        body: event.request.body,
        cache: event.request.cache,
        forceCrossOriginIsolated: false,
        initialHeaders: rawheaders,
        rawClientUrl: client ? client.url : undefined,
        clientId: event.clientId || event.resultingClientId,
      },
      event.request.body instanceof ReadableStream ||
        // @ts-expect-error the types for fetchevent are messed up
        event.request.body instanceof ArrayBuffer
        ? [event.request.body]
        : undefined,
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (e) {
    console.error("Service Worker error:", e);
    return new Response(
      "Internal Service Worker Error: " + (e as Error).message,
      {
        status: 500,
      },
    );
  }
}

addEventListener("install", () => {
  self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(clients.claim());
});

// the only way to know if a service worker has suddenly died is if this code runs again
// notify all clients to send over their messageports again
setTimeout(() => {
  console.log("service worker activated, notifying clients to revive");
  void broadcastRevive();
  // short delay is apparently needed
}, 100);
