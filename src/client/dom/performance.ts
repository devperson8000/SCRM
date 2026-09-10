import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
  // NOTE: this rewriter core (dist/scramjet.mjs) is a prebuilt artifact —
  // rebuilding it requires cargo + wasm-bindgen 0.2.105 with crates.io
  // registry access, neither of which this environment has. This change
  // is correct and ready, but won't reach the deployed bundle until
  // someone with that toolchain runs `pnpm build`.
  //
  // Sites often compute performance.mark() startTime relative to their own
  // captured navigation/timeOrigin timestamps. The proxy's extra layers
  // (service worker interception, iframe indirection) shift real elapsed
  // time just enough that some of those computations go negative — and
  // Performance.mark() throws synchronously on a negative startTime per
  // spec. Clamp instead of letting it hard-fail; a slightly-off mark beats
  // aborting whatever script called it.
  client.Proxy("Performance.prototype.mark", {
    apply(ctx) {
      const options = ctx.args[1];
      if (
        options &&
        typeof options === "object" &&
        typeof options.startTime === "number" &&
        options.startTime < 0
      ) {
        ctx.args[1] = { ...options, startTime: 0 };
      }
    },
  });

  client.Trap("PerformanceEntry.prototype.name", {
    get(ctx) {
      // name is going to be a url typically
      const name = String(ctx.get());

      if (name && name.startsWith(client.context.prefix.href)) {
        return client.unrewriteUrl(name);
      }

      return name;
    },
  });

  const filterEntries = (entries: PerformanceEntry[]) => {
    return entries.filter((entry) => {
      for (const file of client.config.maskedfiles) {
        const name = String(
          client.descriptors.get("PerformanceEntry.prototype.name", entry),
        );
        if (name.endsWith(file)) {
          return false;
        }
      }

      return true;
    });
  };

  client.Proxy(
    [
      "Performance.prototype.getEntries",
      "Performance.prototype.getEntriesByType",
      "Performance.prototype.getEntriesByName",
      "PerformanceObserverEntryList.prototype.getEntries",
      "PerformanceObserverEntryList.prototype.getEntriesByType",
      "PerformanceObserverEntryList.prototype.getEntriesByName",
    ],
    {
      apply(ctx) {
        const entries = ctx.call() as PerformanceEntry[];

        return ctx.return(filterEntries(entries));
      },
    },
  );
}
