/**
 * The macOS trash, through `NSFileManager`, which `osascript` reaches from
 * JavaScript for Automation.
 *
 * Not Finder, and not a `rename()` into `~/.Trash`. AGENTS.md beside this file
 * has the comparison; the short of it is that this is the one of the three that
 * needs no permission prompt, no GUI session, and no rules of ours about which
 * volume's trash an item belongs in or what a second `a.txt` is called.
 */

import { __ } from '../i18n/index.js';
import { run } from './spawn.js';

/**
 * The script. The path comes in as an argument, never inside the source, so no
 * name can be read as code. The answer is JSON with every character past ASCII
 * escaped, so nothing depends on what encoding `osascript` writes.
 *
 * `$()` rather than `Ref()` for the two out parameters: `Ref()` crashes
 * `osascript` with a segfault on this call once the item has already been moved,
 * which is the one moment a crash cannot be allowed -- the caller would be told
 * it failed about a file that is in the trash.
 */
const SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const moved = $();
  const error = $();
  const ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, moved, error);
  const answer = ok ? { path: moved.path.js } : { error: error.localizedDescription.js };
  return JSON.stringify(answer).replace(/[\\u007f-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}`;

/**
 * Moves a file or a directory to the trash for the volume it is on.
 *
 * @param path - Absolute.
 * @returns Where it went, which `NSFileManager` chose, `a 2.txt` beside an
 *   `a.txt` already in the trash.
 * @throws If `NSFileManager` would not, with its reason.
 */
export async function trashMacos(path: string): Promise<string> {
  const out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, path]);
  let answer: { error?: string; path?: string };
  try {
    answer = JSON.parse(out);
  } catch {
    throw new Error(__`osascript answered ${JSON.stringify(out.trim())}`);
  }
  if (answer.path === undefined) {
    throw new Error(answer.error ?? __`osascript gave no reason`);
  }
  return answer.path;
}
