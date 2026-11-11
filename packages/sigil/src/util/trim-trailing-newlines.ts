/**
 * A string with every `\r` and `\n` at its end taken off, and nothing else.
 *
 * Written as a walk back from the end rather than as `replace(/[\r\n]+$/, '')`,
 * because that pattern is quadratic in an interior run: it is not anchored at
 * its start, so the engine tries a run of k newlines from each of its k
 * positions and fails each attempt only at the first character that is not one
 * -- k² steps for a run that is not at the end at all. Error messages echo argv,
 * so one argument holding a long run of newlines stalled the error path:
 * measured, `errorHandler()` took 180 ms at 20,000 newlines and 2,989 ms at
 * 80,000. This reads each trailing character once and slices once.
 *
 * One function rather than one per caller, because the rule is the same at
 * every site that writes exactly one trailing newline: `errorHandler()`,
 * `main()`'s serializer output, and `runApp()`'s error report.
 *
 * @param text - The text to trim.
 * @returns `text` without its trailing run of `\r` and `\n`.
 */
export function trimTrailingNewlines(text: string): string {
  let end = text.length;

  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x0a && code !== 0x0d) {
      break;
    }
    end--;
  }

  return end === text.length ? text : text.slice(0, end);
}
