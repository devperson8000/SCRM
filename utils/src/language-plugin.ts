import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

export type LanguagePluginOptions = {
  /**
   * Raw Accept-Language header value to send on every proxied request, e.g.
   * "en-US,en;q=0.9". Defaults to a value built from the browser's own
   * navigator.languages, so the proxy preserves the user's real language
   * preference instead of leaking the exit server's.
   */
  acceptLanguage?: string;
};

function acceptLanguageFromNavigator(): string {
  const languages =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || "en-US"];
  return languages
    .map((lang, i) =>
      i === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`,
    )
    .join(", ");
}

/**
 * Many sites (YouTube prominently among them) choose their UI language from
 * the exit server's IP geolocation rather than the browser's Accept-Language
 * header, which makes the proxy's hosting region leak into every site's
 * language regardless of what the user's own browser is set to. Forcing the
 * outbound Accept-Language header on every request to match the browser's
 * real language preference keeps that decision tied to the user, not the
 * server's datacenter.
 */
export class LanguagePlugin extends ManagedPlugin {
  private readonly headerValue: string;

  constructor(options: LanguagePluginOptions = {}) {
    super("language", []);
    this.headerValue = options.acceptLanguage ?? acceptLanguageFromNavigator();
  }

  install(frame: Frame): void {
    super.install(frame);
    this.tap(frame.hooks.fetch.request, (_ctx, props) => {
      props.init.headers = props.init.headers.filter(
        ([key]) => key.toLowerCase() !== "accept-language",
      );
      props.init.headers.push(["accept-language", this.headerValue]);
    });
  }
}
