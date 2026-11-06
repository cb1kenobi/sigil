import { useSyncExternalStore } from 'react';

const subscribe = (): (() => void) => () => {};

/**
 * Whether the page has hydrated: `false` on the server and for the hydration
 * pass itself, `true` for every render after it.
 *
 * What lets a component show something only the browser knows (the address that
 * missed, the referrer) without a hydration mismatch. React renders
 * `getServerSnapshot` for the hydration pass on the client too, and re-renders
 * with `getSnapshot` straight afterwards, so the first client render matches the
 * server's HTML exactly. A component that read `location` during render would
 * not.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
