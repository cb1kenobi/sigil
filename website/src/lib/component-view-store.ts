import { VIEW_IDS, type ViewId } from './components.ts';

/**
 * Which output view a reader last chose on a component page, for the rest of
 * their session: choose Accessible on `select()` and `multiselect()` opens on it
 * too.
 *
 * `sessionStorage`, because the ticket asks for it remembered "per page
 * session" -- the tab's session, gone when the tab is -- and because the choice
 * is a reading mode rather than a preference worth keeping for good. The shape is
 * the one `packageManagerStore` has for `useSyncExternalStore`: storage is the
 * answer when it has one, the in-memory choice is what keeps a page in step when
 * it has none, and the server, which has neither, says Rendered.
 */

const KEY = 'sigil:component-output-view';

/** The view a server render and a first visit show. */
export const DEFAULT_VIEW: ViewId = 'rendered';

const listeners = new Set<() => void>();
let chosen: ViewId | undefined;

function read(): ViewId | undefined {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    return VIEW_IDS.find((id) => id === stored);
  } catch {
    // storage refused, as a private window or a sandboxed frame may
    return undefined;
  }
}

export const componentViewStore = {
  getSnapshot(): ViewId {
    return read() ?? chosen ?? DEFAULT_VIEW;
  },

  getServerSnapshot(): ViewId {
    return DEFAULT_VIEW;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  select(view: ViewId): void {
    chosen = view;
    try {
      window.sessionStorage.setItem(KEY, view);
    } catch {
      // remembered for this page only, then
    }
    for (const listener of listeners) {
      listener();
    }
  },
};
