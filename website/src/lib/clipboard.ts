/**
 * Copies text to the clipboard. Resolves `true` if it landed and `false` if it
 * did not, and never throws: a copy button that cannot copy has nothing useful
 * to tell the reader, who can still select the text on screen.
 *
 * `navigator.clipboard` is tried first. It is absent on an insecure origin
 * (plain http that is not localhost), it rejects when the permission is denied
 * and it rejects in an iframe without `clipboard-write`, so it is the right
 * first choice and cannot be the only one. The fallback is a hidden textarea
 * and `document.execCommand('copy')`: deprecated, and still the one thing every
 * browser answers in those three cases.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea.
  }

  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }

  // Selecting the textarea moves focus, and a reader who copied from a button
  // should still be on that button afterwards.
  const previous = document.activeElement;
  const textarea = document.createElement('textarea');

  try {
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    // Off-screen rather than `display: none`, which cannot be selected, and
    // fixed so that appending it never scrolls the page.
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    (previous as HTMLElement | null)?.focus?.();
  }
}
