// The default prefix every proxied URL is served under. It lives in its own
// module because both halves of the controller need it and they are built into
// separate bundles: the page half (index.ts) as the default of `config.prefix`,
// and the service worker half (sw.ts) as the one thing it can know about
// routing without being told — see PREFIX_ROOTS there.
export const DEFAULT_PREFIX = "/~/sj/";
