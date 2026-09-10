import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
export type LinkHandlerPluginOptions = {};
/**
 * Intercepts only links that explicitly request a new tab (target, modifier,
 * or middle-click) so they open through the host application's tab callback.
 * Ordinary left-clicks remain native navigation. Requires
 * {@link EventHandlerPlugin} on the same frame.
 */
export declare class LinkHandlerPlugin extends ManagedPlugin {
    private onNewTab;
    private options;
    constructor(onNewTab: (url: string) => void, options?: LinkHandlerPluginOptions);
    install(frame: Frame): void;
}
