/**
 * The key that opens search, as the badge in the header spells it.
 *
 * The dialog itself (SIG-254) opens on both `Cmd+K` and `Ctrl+K`, and `/`; the
 * badge names only the one the reader's keyboard has, which is a question the
 * server cannot answer.
 */

export type SearchShortcutLabel = '⌘K' | 'Ctrl K';

/** What the server renders, and what hydration is compared against. */
export const SERVER_SHORTCUT: SearchShortcutLabel = '⌘K';

/** The slice of `navigator` that names a platform. */
export interface PlatformSource {
  /** Chromium's replacement for `platform`: `macOS`, `Windows`, `Linux`. */
  userAgentData?: { platform?: string };
  /** Deprecated but everywhere: `MacIntel`, `Win32`, `Linux x86_64`. */
  platform?: string;
}

/**
 * Whether a platform name is Apple's, where the key is Command.
 *
 * iPadOS reports `MacIntel`, which is why a name that starts with `mac` is
 * enough for it. Everything unknown is not Apple: `Ctrl K` works there, since
 * the dialog takes both.
 */
export function isApplePlatform(platform: string | undefined): boolean {
  return /^(mac|iphone|ipad|ipod)/iu.test(platform ?? '');
}

export function searchShortcutLabel(source: PlatformSource | undefined): SearchShortcutLabel {
  const platform = source?.userAgentData?.platform || source?.platform;
  return isApplePlatform(platform) ? '⌘K' : 'Ctrl K';
}

/**
 * The shape `useSyncExternalStore` takes. Nothing changes after load, so
 * `subscribe` has nothing to do.
 *
 * This is what avoids a hydration mismatch: React renders `getServerSnapshot`
 * for the hydration pass on the client as well, and only then re-renders with
 * `getSnapshot` if it differs. A component that read `navigator` during render
 * would produce `Ctrl K` on a Windows client against the server's `⌘K`.
 * On a PC the badge changes once, right after hydration. The trigger is a
 * fixed width and the badge sits at its right edge, so nothing else moves.
 */
export const searchShortcutStore = {
  subscribe: (): (() => void) => () => {},
  getSnapshot: (): SearchShortcutLabel =>
    searchShortcutLabel(typeof navigator === 'undefined' ? undefined : navigator),
  getServerSnapshot: (): SearchShortcutLabel => SERVER_SHORTCUT,
};
