'use client';

import { capture, type AnalyticsEvents } from '@/lib/analytics';
import { copyText } from '@/lib/clipboard';
import type { CopyEventName } from '@/lib/fence';
import { useEffect, useRef, useState } from 'react';

/** How long the button says what happened before it goes back to "Copy". */
const SETTLED_FOR = 2000;

/** What the button is saying. */
type Said = 'idle' | 'copied' | 'selected';

const LABEL: Record<Said, string> = { copied: 'Copied', idle: 'Copy', selected: 'Selected' };

/**
 * An event to send in place of `command_copied`, with its properties: worked
 * out on the server, like the text, so the button only has to send it.
 */
export type CopyEvent = {
  [E in CopyEventName]: { readonly name: E; readonly properties: AnalyticsEvents[E] };
}[CopyEventName];

export interface CopyButtonProps {
  /** What it copies: the block's plain text, never its markup. */
  readonly text: string;
  /** What it is for, said to a screen reader: "Copy src/index.ts". */
  readonly label: string;
  /** Which kind of block it sits on, for `command_copied`. */
  readonly location: string;
  /** The block's language, for `command_copied`. */
  readonly language?: string;
  /** What to send instead of `command_copied`: the agent instructions' own event. */
  readonly event?: CopyEvent;
}

/**
 * The Copy button in a code or terminal block's title bar.
 *
 * Copies `text` -- which the block worked out on the server, so what reaches the
 * clipboard is exactly the text and none of the spans it is drawn with -- and
 * says "Copied" for two seconds.
 *
 * When the clipboard refuses, the block's body is **selected** instead and the
 * button says "Selected": the reader's own Ctrl+C then does what the button
 * could not, which is a better outcome than a button that silently did nothing.
 * The body is found from the button rather than passed in, through the
 * `data-copy-block` and `data-copy-body` attributes the two blocks put on
 * themselves, so a server component does not need a ref or an id to hand over.
 *
 * What changed is announced through a live region beside the button, because a
 * button's own text changing is not something every screen reader reads out.
 */
export function CopyButton({ event, label, language, location, text }: CopyButtonProps) {
  const [said, setSaid] = useState<Said>('idle');
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = (next: Said) => {
    setSaid(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid('idle'), SETTLED_FOR);
  };

  const onClick = async () => {
    if (await copyText(text)) {
      // a no-op when analytics is not configured, which `capture()` decides
      if (event) {
        capture(event.name, event.properties);
      } else {
        capture('command_copied', { location, ...(language ? { language } : {}) });
      }
      settle('copied');
      return;
    }

    const body = button.current?.closest('[data-copy-block]')?.querySelector('[data-copy-body]');
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (body && selection) {
      const range = document.createRange();
      range.selectNodeContents(body);
      selection.removeAllRanges();
      selection.addRange(range);
      settle('selected');
    }
  };

  return (
    <>
      <button
        aria-label={said === 'idle' ? label : LABEL[said]}
        // 30px drawn and 44px to a finger: the title bar is 46px, so the
        // target grows into its padding without moving anything.
        className="relative h-[30px] shrink-0 cursor-pointer rounded-btn-sm border border-line-input bg-surface-2 px-2.5 font-mono text-xs text-fg-body after:absolute after:inset-x-0 after:-inset-y-[8px] hover:border-line-strong hover:text-fg-strong"
        onClick={onClick}
        ref={button}
        type="button"
      >
        {LABEL[said]}
      </button>
      <span aria-live="polite" className="sr-only">
        {said === 'copied' ? 'Copied' : said === 'selected' ? 'Selected; press Ctrl+C to copy' : ''}
      </span>
    </>
  );
}
