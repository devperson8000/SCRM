import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
import { EventHandlerPlugin } from "./event-handler-plugin";

export type LinkHandlerPluginOptions = {};

/**
 * Intercepts only links that explicitly request a new tab (target, modifier,
 * or middle-click) so they open through the host application's tab callback.
 * Ordinary left-clicks remain native navigation. Requires
 * {@link EventHandlerPlugin} on the same frame.
 */
export class LinkHandlerPlugin extends ManagedPlugin {
  constructor(
    private onNewTab: (url: string) => void,
    private options: LinkHandlerPluginOptions = {},
  ) {
    super("link-handler", ["event-handler"]);
  }

  install(frame: Frame): void {
    this.tap(
      frame.hooks.init.post,
      (context) => {
        const eventHandler = frame.plugins.find(
          (p): p is EventHandlerPlugin => p.name === "event-handler",
        )!;
        const findAnchor = (event: MouseEvent) =>
          event
            .composedPath()
            .find(
              (node): node is HTMLAnchorElement =>
                node instanceof context.window.HTMLAnchorElement,
            );
        const shouldOpenInNewTab = (
          event: MouseEvent,
          anchor: HTMLAnchorElement,
        ) =>
          event.button === 1 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          anchor.target === "_blank" ||
          anchor.target === "_new";
        const openInNewTab = (event: MouseEvent) => {
          const anchor = findAnchor(event);
          if (
            !anchor?.href ||
            event.defaultPrevented ||
            !shouldOpenInNewTab(event, anchor)
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          this.onNewTab(anchor.href);
        };

        eventHandler.addEventListener(
          context.window.document,
          "click",
          openInNewTab,
        );
        eventHandler.addEventListener(
          context.window.document,
          "auxclick",
          openInNewTab,
        );
      },
      { after: ["event-handler"] },
    );
  }
}
