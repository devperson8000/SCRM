import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
export declare const CACHE_NAME = "scramjet-http-cache-v3";
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
export declare class HttpCachePlugin extends ManagedPlugin {
    readonly cacheName: string;
    private cachePromise;
    private cameFromCache;
    private pendingRevalidation;
    constructor(options?: HttpCachePluginOptions);
    /** Lazy-open the underlying Cache. Memoized for the plugin's lifetime. */
    private openCache;
    private pruneSupersededCaches;
    /** Write to the Cache API without holding up the response. */
    private storeInBackground;
    install(frame: Frame): void;
    /**
     * Turn a 304 into the response the caller actually wanted: the stored
     * body, under the stored headers updated by whatever the 304 carried
     * (RFC 9111 §4.3.4). Also refreshes the stored entry so its freshness
     * clock restarts without another download.
     */
    private serveRevalidated;
    /**
     * Drop every entry in the HTTP cache. Returns whether the underlying
     * Cache existed and was deleted.
     */
    bust(): Promise<boolean>;
}
