/**
 * Puts text on the clipboard, and says whether it worked.
 *
 * One definition for every Copy button on the site -- the code and terminal
 * blocks (SIG-258) and the install box (SIG-259) -- so that what "copied" means
 * is decided once.
 *
 * `navigator.clipboard.writeText` first. It is absent on an insecure origin and
 * can be refused by a permission policy, an iframe without `clipboard-write`, or
 * a browser that wants a gesture it does not think it got, so on any failure
 * this falls back to the way copying worked before the API existed: a hidden
 * textarea holding the text, selected, and `document.execCommand('copy')`.
 * `execCommand` is deprecated, and is still the only thing that works in exactly
 * the places the modern API does not.
 *
 * It never throws, because it runs in a click handler: an exception there is a
 * button that does nothing and an error the reader cannot act on. A caller that
 * gets `false` decides what to do instead -- the blocks select their text, so
 * that the reader's own Ctrl+C finishes the job.
 *
 * @param text - What to copy.
 * @returns Whether the text reached the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refused or unavailable: the fallback below is the answer to both
  }

  try {
    return copyWithTextarea(text);
  } catch {
    return false;
  }
}

/**
 * The fallback: a textarea nobody sees, selected and copied.
 *
 * Off-screen rather than `display: none`, which cannot hold a selection, and
 * `readonly` so that a phone does not raise its keyboard for it. Whatever was
 * focused and selected before is put back afterwards, because taking a reader's
 * place on the page to copy something is not something they asked for.
 */
function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }

  const focused = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, at) => selection.getRangeAt(at))
    : [];

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';

  let copied = false;
  try {
    document.body.append(area);
    area.select();
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    try {
      focused?.focus?.();
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) {
          selection.addRange(range);
        }
      }
    } catch {
      // putting the reader's place back is a courtesy, never a failure
    }
  }

  return copied;
}
