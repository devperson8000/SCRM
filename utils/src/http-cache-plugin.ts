// HTTP cache plugin for ScramjetFetchHandler.
//
// Service-worker `fetch` ignores the browser's HTTP cache, so without this
// every navigation re-runs the full network fetch even for unchanged
// resources. This plugin caches the **upstream** response (the BareResponse
// as received from the network, BEFORE rewriteResponseHeaders / rewriteBody
// run). On a hit we hand that same untouched response to the pipeline, which
// then re-rewrites with the current Frame's prefix.
//
// Storing pre-rewrite means:
//   - The cache is shared across Frames, Controllers, and page reloads --
//     one Frame's hit serves another Frame's request because the stored
//     bytes contain only the upstream's URLs, not any frame-bound prefix.
//   - Redirect Location / Content-Location and Link headers come out of
//     `rewriteResponseHeaders` correctly on each hit, because that runs
//     on the cache-derived response just like a fresh one.
//   - We don't skip the rewriter on hit; we only skip the network. That's
//     where the win actually is for service-worker proxying.
//
// Nothing here buffers a whole body. The `preresponse` tap runs inside the
// request's critical path (see doNetworkFetch: it is awaited before the
// response reaches rewriteBody), so draining the stream to an ArrayBuffer
// there would stall every cacheable response -- images, media and XHR
// included -- until its last byte arrived, turning responses that stream
// today into all-or-nothing waits. Instead the body is `tee()`d: one branch
// continues down the pipeline untouched, the other is handed to the Cache
// API, and the write is *not* awaited.
//
// Implementation aims for RFC 9111 (HTTP caching) compliance for a
// PRIVATE cache (browser-local, single-user):
//
//   - Only GET is cached. HEAD is deliberately excluded: its body-less
//     response shares a URL with the GET it mirrors, so storing one would
//     serve an empty body to a later GET.
//   - Cacheable status codes per RFC 9110 §15.1: 200 203 204 300 301 308
//     404 405 410 414 501. Other statuses pass through. 206 is omitted
//     because the Cache API spec (Service Workers §cache-put) rejects
//     partial responses outright.
//   - `Cache-Control: no-store` and `Vary: *` opt out.
//   - Freshness:
//       1. `Cache-Control: s-maxage` (private cache treats this same as
//          max-age),
//       2. `Cache-Control: max-age`,
//       3. `Expires`,
//       4. heuristic 10% × (Date - Last-Modified) per RFC 9111 §4.2.2.
//   - `Cache-Control: no-cache` / `Pragma: no-cache` / `Cache-Control:
//     immutable` are honoured.
//   - `Vary` is honoured by storing one entry per (URL × selected-headers)
//     pair via the underlying Cache API's built-in matching.
//   - A stale entry that carries an ETag or Last-Modified is revalidated
//     with a conditional request (RFC 9111 §4.3): we add If-None-Match /
//     If-Modified-Since on the way out, and on a 304 we serve the stored
//     body and refresh the entry's headers rather than re-downloading it.

import {
  BareResponse,
  type ScramjetFetchRequest,
  type ScramjetHeaders,
} from "@mercuryworkshop/scramjet";
import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

// v3: v2 keyed HEAD and GET responses alike, so a HEAD could store an empty
// body that a later GET would then be served.
export const CACHE_NAME = "scramjet-http-cache-v3";

/** Every cache this plugin has ever used, for pruning superseded versions. */
const CACHE_NAME_PREFIX = "scramjet-http-cache";

/** Header recording when this entry entered the cache (ms since epoch). */
const STORED_AT_HEADER = "x-sj-cached-at";

/**
 * Status codes RFC 9110 §15.1 marks as "cacheable by default", minus 206:
 * the Cache API rejects partial responses (cache.put throws TypeError on
 * any non-200/non-OK response with a Content-Range), so storing them is a
 * non-starter regardless of what HTTP allows.
 */
const DEFAULT_CACHEABLE_STATUSES = new Set([
  200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501,
]);

/**
 * Statuses for which the Fetch spec forbids a body. The Response constructor
 * throws TypeError if you pair any of these with a body -- even an empty
 * string or 0-byte buffer.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Validators the page attached itself. We strip these: scramjet's
 * doHandleFetch classifies any 3xx as a redirect and immediately parses the
 * Location header, so a 304 coming back from upstream throws `Invalid URL`
 * and fails the request outright. Removing them makes the origin answer with
 * the full 200 -- always a legal response to a conditional request -- which
 * we then serve and store normally.
 */
const CLIENT_VALIDATOR_HEADERS = new Set([
  "if-none-match",
  "if-modified-since",
]);

/**
 * Range requests get out of the cache's way entirely: the answer is a 206
 * the Cache API refuses to store, and handing back a full stored body in its
 * place would make a media element download the whole file to seek.
 */
const RANGE_HEADERS = new Set(["range", "if-range"]);

/**
 * Headers a 304 must not be allowed to overwrite on the stored entry: they
 * describe the stored body, which the 304 by definition doesn't carry.
 */
const NOT_UPDATED_BY_304 = new Set(["content-length", "content-encoding"]);

interface CacheControlDirectives {
  "no-store"?: boolean;
  "no-cache"?: boolean;
  "must-revalidate"?: boolean;
  "proxy-revalidate"?: boolean;
  private?: boolean;
  public?: boolean;
  "max-age"?: number;
  "s-maxage"?: number;
  "stale-while-revalidate"?: number;
  "stale-if-error"?: number;
  immutable?: boolean;
}

function parseCacheControl(value: string | null): CacheControlDirectives {
  const out: CacheControlDirectives = {};
  if (!value) return out;
  for (const raw of value.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq))
      .trim()
      .toLowerCase() as keyof CacheControlDirectives;
    if (eq === -1) {
      (out as any)[name] = true;
      continue;
    }
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (
      name === "max-age" ||
      name === "s-maxage" ||
      name === "stale-while-revalidate" ||
      name === "stale-if-error"
    ) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) (out as any)[name] = n;
    } else {
      (out as any)[name] = true;
    }
  }
  return out;
}

/**
 * RFC 9111 §4.2.1 freshness lifetime calculation, simplified for a private
 * cache (so s-maxage is treated identically to max-age).
 */
function freshnessLifetimeSeconds(
  headers: Headers,
  cc: CacheControlDirectives,
  dateMs: number,
): number | null {
  if (cc["s-maxage"] !== undefined) return cc["s-maxage"];
  if (cc["max-age"] !== undefined) return cc["max-age"];

  const expires = headers.get("expires");
  if (expires) {
    const expMs = Date.parse(expires);
    if (Number.isFinite(expMs)) {
      return Math.max(0, (expMs - dateMs) / 1000);
    }
  }

  const lastModified = headers.get("last-modified");
  if (lastModified) {
    const lmMs = Date.parse(lastModified);
    if (Number.isFinite(lmMs) && lmMs <= dateMs) {
      // RFC 9111 §4.2.2 heuristic: 10% of the time since Last-Modified.
      return ((dateMs - lmMs) * 0.1) / 1000;
    }
  }

  return null;
}

/** Current age (seconds) of a stored response per RFC 9111 §4.2.3. */
function currentAgeSeconds(headers: Headers, storedAtMs: number): number {
  const ageHeader = headers.get("age");
  const initialAge = ageHeader ? parseInt(ageHeader, 10) || 0 : 0;
  const residentTime = (Date.now() - storedAtMs) / 1000;
  return initialAge + residentTime;
}

/**
 * Only GET. HEAD would otherwise be stored under the same key as the GET for
 * the same URL, and its empty body would then be served to that GET.
 */
function isCacheableMethod(method: string): boolean {
  return method === "GET";
}

/**
 * Whether a response (status + Cache-Control + Vary) is allowed to be stored.
 * RFC 9110 §15.1 + RFC 9111 §3. `headers` is the upstream's raw response
 * headers, not yet through scramjet's response-header rewriter.
 */
function responseIsStorable(
  status: number,
  headers: Headers,
  method: string,
): boolean {
  if (!isCacheableMethod(method)) return false;
  if (!DEFAULT_CACHEABLE_STATUSES.has(status)) return false;

  const cc = parseCacheControl(headers.get("cache-control"));
  if (cc["no-store"]) return false;

  // "Vary: *" means "never reusable".
  const vary = headers.get("vary");
  if (vary && vary.split(",").some((v) => v.trim() === "*")) return false;

  return true;
}

/** Build a synthetic cache-key Request keyed by the *underlying* URL. */
function buildCacheKeyRequest(
  parsedUrl: string,
  headers: ScramjetHeaders,
): Request {
  const native = new Headers();
  for (const [k, v] of headers.toRawHeaders()) {
    try {
      native.append(k, v);
    } catch {}
  }
  const cacheKeyUrl =
    "https://sj-cache.invalid/" + encodeURIComponent(parsedUrl);
  return new Request(cacheKeyUrl, { method: "GET", headers: native });
}

/** Rebuild a Headers object from the BareResponse's rawHeaders array. */
function nativeHeadersFromRaw(
  raw: ReadonlyArray<readonly [string, string]>,
): Headers {
  const h = new Headers();
  for (const [k, v] of raw) {
    try {
      h.append(k, v);
    } catch {
      // some upstream headers (e.g. malformed Set-Cookie) are rejected
      // by the native Headers; just drop them.
    }
  }
  return h;
}

/**
 * Read a Headers into [name, value] pairs, keeping repeated Set-Cookie
 * fields separate.
 *
 * Iterating a Headers is specified to yield each Set-Cookie individually, but
 * only since 2022; where `getSetCookie` exists we use it as the authoritative
 * source and skip the iterator's Set-Cookie entries, and where it doesn't we
 * fall back to whatever the iterator gave us. Getting this wrong turns two
 * cookies into one corrupt `a=1, b=2` header, and scramjet's cookie jar
 * parses these pairs directly.
 */
function headerPairs(headers: Headers): [string, string][] {
  const canSplitCookies = typeof headers.getSetCookie === "function";
  const out: [string, string][] = [];

  for (const [k, v] of headers.entries()) {
    if (canSplitCookies && k.toLowerCase() === "set-cookie") continue;
    out.push([k, v]);
  }
  if (canSplitCookies) {
    for (const cookie of headers.getSetCookie())
      out.push(["set-cookie", cookie]);
  }

  return out;
}

/** Flatten a Headers into scramjet's raw [name, value][] form. */
function rawHeadersFromNative(headers: Headers): [string, string][] {
  return headerPairs(headers);
}

/** Strip our internal bookkeeping from a stored Response's headers. */
function strippedHeadersFromStored(stored: Response): Headers {
  const out = new Headers();
  for (const [k, v] of headerPairs(stored.headers)) {
    if (k.toLowerCase() === STORED_AT_HEADER) continue;
    try {
      out.append(k, v);
    } catch {}
  }

  return out;
}

/**
 * Wrap a body + headers in a BareResponse the fetch pipeline can consume.
 *
 * `url` matters: BareResponse.fromNativeResponse copies `Response.url`, which
 * is the empty string on any response we construct ourselves. That's the name
 * the JS rewriter reports for the script, so building these by hand and
 * carrying the real URL across keeps cached scripts identifiable.
 */
function buildBareResponse(
  body: BodyInit | null,
  init: { status: number; statusText: string; headers: Headers; url: string },
): BareResponse {
  const usableBody = NULL_BODY_STATUSES.has(init.status) ? null : body;
  const response = new BareResponse(usableBody, {
    status: init.status,
    statusText: init.statusText,
    headers: init.headers,
  });
  response.url = init.url;
  response.rawHeaders = rawHeadersFromNative(init.headers);
  response.redirected = false;

  return response;
}

/**
 * Build a `Response` to put in the Cache API. Tags it with our internal
 * STORED_AT_HEADER so freshness can be computed on later lookups.
 */
function buildStorableResponse(
  body: BodyInit | null,
  status: number,
  statusText: string,
  headers: Headers,
): Response {
  const native = new Headers(headers);
  native.set(STORED_AT_HEADER, String(Date.now()));

  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    statusText,
    headers: native,
  });
}

/** A stored entry we sent a conditional request for, awaiting its 304. */
interface PendingRevalidation {
  stored: Response;
  cacheKey: Request;
}

export interface HttpCachePluginOptions {
  /** Name of the underlying Cache API entry. Defaults to CACHE_NAME. */
  cacheName?: string;
}

/**
 * RFC-9111-ish HTTP cache for ScramjetFetchHandler.
 *
 * One instance can be installed onto multiple Frames -- the WeakMap of
 * "did this request come from cache?" book-keeping is per-instance, not
 * per-Frame, so nothing leaks across installs.
 */
export class HttpCachePlugin extends ManagedPlugin {
  readonly cacheName: string;

  private cachePromise: Promise<Cache> | null = null;
  // Marks requests whose `earlyResponse` we sourced from the cache, so the
  // preresponse hook below knows not to re-store them. WeakMap keys are
  // the request objects so entries clean themselves up automatically.
  private cameFromCache = new WeakMap<ScramjetFetchRequest, true>();
  // Requests we attached If-None-Match / If-Modified-Since to, with the
  // stored entry their 304 would refer to.
  private pendingRevalidation = new WeakMap<
    ScramjetFetchRequest,
    PendingRevalidation
  >();

  constructor(options: HttpCachePluginOptions = {}) {
    super("scramjet-http-cache", []);
    this.cacheName = options.cacheName ?? CACHE_NAME;
  }

  /** Lazy-open the underlying Cache. Memoized for the plugin's lifetime. */
  private openCache(): Promise<Cache> {
    if (!this.cachePromise) {
      this.cachePromise = caches.open(this.cacheName).then((cache) => {
        // Older cache versions are otherwise never reclaimed; a
        // superseded one can sit on hundreds of megabytes of quota
        // that the live cache then can't use.
        this.pruneSupersededCaches();

        return cache;
      });
    }

    return this.cachePromise;
  }

  private pruneSupersededCaches(): void {
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(CACHE_NAME_PREFIX) && name !== this.cacheName,
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .catch(() => {});
  }

  /** Write to the Cache API without holding up the response. */
  private storeInBackground(cacheKey: Request, response: Response): void {
    this.openCache()
      .then((cache) => cache.put(cacheKey, response))
      .catch((err) => {
        // Cache.put can fail on opaque or oddly-headered responses, and
        // on a quota overrun; don't let a cache write failure break the
        // actual fetch.
        console.warn("[scramjet-http-cache] cache.put failed:", err);
      });
  }

  install(frame: Frame): void {
    super.install(frame);

    const hooks = frame.fetchHandler.hooks.fetch;

    // ----- request: cache lookup --------------------------------------
    this.tap(hooks.request, async (ctx, props) => {
      const req = ctx.request;
      if (!isCacheableMethod(req.method)) return;
      const reqCache = req.cache as string;
      // Honour the request's own cache mode where it asks for fresh data.
      if (reqCache === "no-store" || reqCache === "reload") return;
      // Don't undo an earlyResponse another plugin already set.
      if (props.earlyResponse) return;

      // The page is fetching a byte range. Leave it to the network: its
      // 206 isn't storable, and answering with a whole stored body would
      // defeat the point of asking for a range.
      const outgoing = (props.init.headers ??= []);
      if (outgoing.some(([name]) => RANGE_HEADERS.has(name.toLowerCase()))) {
        return;
      }

      // Drop the page's own validators (see CLIENT_VALIDATOR_HEADERS): a
      // 304 reaching scramjet's redirect handling fails the request.
      for (let i = outgoing.length - 1; i >= 0; i--) {
        if (CLIENT_VALIDATOR_HEADERS.has(outgoing[i][0].toLowerCase())) {
          outgoing.splice(i, 1);
        }
      }

      const cacheKey = buildCacheKeyRequest(
        ctx.parsed.url.href,
        req.initialHeaders,
      );
      const cache = await this.openCache();
      const stored = await cache.match(cacheKey);
      if (!stored) {
        return;
      }

      const storedAt = parseInt(
        stored.headers.get(STORED_AT_HEADER) ?? "0",
        10,
      );
      const cc = parseCacheControl(stored.headers.get("cache-control"));

      const pragmaNoCache = (stored.headers.get("pragma") ?? "")
        .toLowerCase()
        .includes("no-cache");
      const mustRevalidateBeforeUse =
        cc["no-cache"] === true || pragmaNoCache || reqCache === "no-cache";

      const dateMs = (() => {
        const d = stored.headers.get("date");
        if (d) {
          const v = Date.parse(d);
          if (Number.isFinite(v)) return v;
        }
        return storedAt || Date.now();
      })();

      const lifetime = freshnessLifetimeSeconds(stored.headers, cc, dateMs);
      const age = currentAgeSeconds(stored.headers, storedAt);
      const fresh =
        !mustRevalidateBeforeUse && lifetime !== null && age < lifetime;

      // `immutable` short-circuits the freshness check (RFC 8246)
      // provided the client hasn't asked for a forced revalidation.
      const immutable =
        cc.immutable === true &&
        reqCache !== "no-cache" &&
        reqCache !== "reload";

      if (!fresh && !immutable) {
        // Stale. If the entry carries a validator we can ask the origin
        // whether it still holds instead of re-downloading the body --
        // a 304 is a couple of hundred bytes through the tunnel where
        // the response itself may be megabytes.
        const etag = stored.headers.get("etag");
        const lastModified = stored.headers.get("last-modified");
        if (etag || lastModified) {
          if (etag) outgoing.push(["If-None-Match", etag]);
          else outgoing.push(["If-Modified-Since", lastModified!]);
          this.pendingRevalidation.set(req, { stored, cacheKey });
        }

        return;
      }

      // Build a BareResponse around the stored bytes/headers and hand
      // it to doNetworkFetch via earlyResponse. The pipeline will then
      // run rewriteResponseHeaders/rewriteBody/etc. as if we'd just
      // fetched it. The body is passed as the stored stream rather than
      // buffered, so a hit starts delivering immediately.
      const headers = strippedHeadersFromStored(stored);
      // Recompute Age the consumer sees so it isn't stuck at storage
      // time.
      if (storedAt) {
        headers.set("age", String(Math.floor((Date.now() - storedAt) / 1000)));
      }

      this.cameFromCache.set(req, true);
      props.earlyResponse = buildBareResponse(stored.body, {
        status: stored.status,
        statusText: stored.statusText,
        headers,
        url: ctx.parsed.url.href,
      });
    });

    // ----- preresponse: cache store -----------------------------------
    this.tap(hooks.preresponse, async (ctx, props) => {
      const req = ctx.request;
      // Skip if this body came back via cache.match -- restoring it
      // would just rewrite the same bytes with a fresh STORED_AT_HEADER
      // (resetting the freshness clock).
      if (this.cameFromCache.has(req)) {
        this.cameFromCache.delete(req);
        return;
      }

      const pending = this.pendingRevalidation.get(req);
      if (pending) {
        this.pendingRevalidation.delete(req);
        if (props.response.status === 304) {
          props.response = this.serveRevalidated(
            pending,
            props.response,
            ctx.parsed.url.href,
          );

          return;
        }
        // Not a 304: the resource changed, and the fresh response below
        // replaces the stored entry under the same key.
      }

      if ((req.cache as string) === "no-store") return;
      if (!isCacheableMethod(req.method)) return;

      const headers = nativeHeadersFromRaw(props.response.rawHeaders);
      if (!responseIsStorable(props.response.status, headers, req.method))
        return;

      const cacheKey = buildCacheKeyRequest(
        ctx.parsed.url.href,
        req.initialHeaders,
      );

      const body = props.response.body;
      if (!body) {
        // 204 and friends: nothing to split, and the pipeline's copy of
        // the response is still untouched.
        this.storeInBackground(
          cacheKey,
          buildStorableResponse(
            null,
            props.response.status,
            props.response.statusText,
            headers,
          ),
        );

        return;
      }

      // Split the stream: one branch keeps flowing down the pipeline,
      // the other feeds the cache write. Neither waits on the other
      // beyond the tee's internal backpressure.
      const [forPipeline, forCache] = body.tee();

      const replacement = buildBareResponse(forPipeline, {
        status: props.response.status,
        statusText: props.response.statusText,
        headers,
        url: props.response.url,
      });
      // Preserve the upstream's exact header list (repeated Set-Cookie
      // included) rather than the round-tripped copy.
      replacement.rawHeaders = props.response.rawHeaders;
      replacement.redirected = props.response.redirected;
      props.response = replacement;

      this.storeInBackground(
        cacheKey,
        buildStorableResponse(
          forCache,
          props.response.status,
          props.response.statusText,
          headers,
        ),
      );
    });
  }

  /**
   * Turn a 304 into the response the caller actually wanted: the stored
   * body, under the stored headers updated by whatever the 304 carried
   * (RFC 9111 §4.3.4). Also refreshes the stored entry so its freshness
   * clock restarts without another download.
   */
  private serveRevalidated(
    pending: PendingRevalidation,
    notModified: BareResponse,
    url: string,
  ): BareResponse {
    const { stored, cacheKey } = pending;

    const headers = strippedHeadersFromStored(stored);
    for (const [k, v] of notModified.rawHeaders) {
      const name = k.toLowerCase();
      if (NOT_UPDATED_BY_304.has(name)) continue;
      if (name === "set-cookie") continue;
      try {
        headers.set(k, v);
      } catch {}
    }
    // The origin just confirmed the entry, so it is no longer aged --
    // unless the 304 itself came from an intermediary that said otherwise.
    if (!notModified.rawHeaders.some(([k]) => k.toLowerCase() === "age")) {
      headers.delete("age");
    }

    // clone() so the same bytes can go to the pipeline and back into the
    // cache; a body can only be read once.
    const refreshed = stored.clone();

    this.storeInBackground(
      cacheKey,
      buildStorableResponse(
        refreshed.body,
        stored.status,
        stored.statusText,
        headers,
      ),
    );

    return buildBareResponse(stored.body, {
      status: stored.status,
      statusText: stored.statusText,
      headers,
      url,
    });
  }

  /**
   * Drop every entry in the HTTP cache. Returns whether the underlying
   * Cache existed and was deleted.
   */
  async bust(): Promise<boolean> {
    try {
      // Drop the memoized handle too; the next install will re-open
      // against a fresh empty cache.
      this.cachePromise = null;
      return await caches.delete(this.cacheName);
    } catch (err) {
      console.error("[scramjet-http-cache] bust failed:", err);
      return false;
    }
  }
}
