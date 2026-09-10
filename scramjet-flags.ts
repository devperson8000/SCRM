import type { ScramjetFlags } from "@mercuryworkshop/scramjet";
import { defaultConfig } from "@mercuryworkshop/scramjet";

/**
 * The flags this deployment runs proxied pages with.
 *
 * This used to be `defaultConfigDev`, which is scramjet's *debugging* profile
 * and costs real page-load time on every site loaded through the proxy:
 *
 *   - `captureErrors` makes the rewriter inject a `$scramerr(e)` call into
 *     every catch block of every script it rewrites, so a page that throws
 *     inside a try/catch in a hot loop (most of them do) pays a console
 *     round-trip per iteration.
 *   - `debugTrampolines` replaces `Reflect.apply` with a `new Function()`
 *     trampoline compiled per proxied property per realm, purely so scramjet
 *     shows up in stack traces. Measured here at ~7ms per realm, and every
 *     iframe and worker on the page is another realm.
 *   - `debugSourceURL` appends a `//# sourceURL=` comment to every script,
 *     which forces an extra full UTF-8 decode plus string concat of script
 *     bytes that would otherwise be handed to the browser as-is.
 *
 * None of the three do anything for someone just browsing. They're all still
 * togglable at runtime from the Flags panel for debugging.
 *
 * `allowInvalidJs` stays on (it already is in `defaultConfig`): a rewriter
 * parse failure should fall back to the original script rather than throw and
 * take the whole page down.
 */
export const appScramjetFlags: ScramjetFlags = {
  ...defaultConfig.flags,
  allowInvalidJs: true,
};

/**
 * localStorage key for the user's flag overrides.
 *
 * Bumped from "scramjet-flags" when the defaults above moved off
 * `defaultConfigDev`: the stored object is a full snapshot of every flag, so
 * anyone who had loaded the app before would otherwise have had the old dev
 * flags re-applied over the new config on mount and never seen the speedup.
 */
export const FLAG_STORE_IDENT = "scramjet-flags-v2";
