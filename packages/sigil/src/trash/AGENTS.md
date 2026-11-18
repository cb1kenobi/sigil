# `packages/sigil/src/trash` — deliberate decisions

These are the decisions about this directory. Claude Code loads this file when
it works with files here; other agents should read it before changing anything
in this area. The root [AGENTS.md](../../../../AGENTS.md) holds the rules that
apply everywhere and still applies in full.

## Deliberate decisions — do not "fix" these

### Moving to the trash, without deleting and without a dependency

`trash(path)` on `@ttylabs/sigil/trash` (SIG-481): a file or a directory goes to
the platform's trash, or stays where it was and the promise rejects. Both file
examples offer it on `t`.

- **It never deletes, and that is the contract rather than a preference.** A
  helper whose point is that a delete can be taken back is worse than none if it
  sometimes cannot be, because the caller has stopped asking. So where a platform
  would delete -- Windows, for an item its bin will not hold -- that is refused,
  and where the trash is on another device -- Linux, for an item on a mount with
  no trash of its own -- nothing is copied there either. A copy and a delete is
  what `mv` across devices is, and a copy of a large directory that fails half
  way leaves two halves.

- **Its own subpath, the way `which` has one.** It is not a base directory, so
  it does not belong on `paths`, and it shells out -- `osascript` and PowerShell
  -- which nothing else on a published subpath does. Measured as of this change:
  20,737 B over five modules, most of it the C# below as a string the minifier
  cannot shorten, so any entry that carried it would carry all of it.

- **The error's message names the whole path, and its `cause` is the reason
  alone.** `Could not move /abs/path to the trash: <reason>` is what a CLI should
  print. A screen that already shows the name wants the reason beside it, which is
  `cause.message`; both examples read it that way. A path that is not there is
  `lstat()`'s `ENOENT`, asked first on every platform, so the three do not phrase
  it three ways. An empty path is a `TypeError`: `resolve('')` is the working
  directory, the last thing to move by accident.

- **It resolves with where the item went.** For a message, and for a test to take
  exactly that back out. It is not a way to restore: each platform keeps where an
  item came from in a record of its own beside it, and only its file manager
  reads that. On Windows it can be empty, in the case the shell recycled an item
  without handing back the new one.

#### macOS: `NSFileManager`, not Finder and not a rename

Three ways were open, and the ticket asked for the trade-off to be written down.

|                     | Finder via `osascript`                       | rename into `~/.Trash`                                 | `NSFileManager` via `osascript`         |
| ------------------- | -------------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Put Back            | yes                                          | no                                                     | not verified (below)                    |
| Permission prompt   | Automation, for the terminal app, mid-delete | none                                                   | none                                    |
| Needs a GUI session | yes: Finder has to be running                | no                                                     | no                                      |
| Another volume      | its `.Trashes`                               | a cross-device copy, or a hand-written `.Trashes/$uid` | its `.Trashes`                          |
| A second `a.txt`    | Finder names it                              | ours to invent                                         | Finder's own naming                     |
| Time                | not measured: it drives Finder               | a syscall                                              | about 50 ms, measured as of this change |

`NSFileManager.trashItemAtURL` is the API Finder's own trash is built on, reached
through JavaScript for Automation, so it is `osascript` without Finder: no
Automation prompt, nothing to deny, and the volume and the naming are the
system's rather than ours. The path is an argument to the script's `run()`, never
inside its source, and the answer is JSON with everything past ASCII escaped.

- **`$()` for the out parameters, not `Ref()`.** `Ref()` segfaults `osascript`
  on this call (exit 139), measured on macOS 27 -- and the first probe showed the
  item was already in the trash when it did, so a crash there would have
  reported a failure for a move that happened.
- **Put Back is not verified.** `~/.Trash` and its `.DS_Store`, where Finder
  keeps the put-back records, cannot be listed or read without Full Disk Access,
  which a terminal does not have by default. What was checked is that an item
  arrives, under the name the method reports, and that removing that exact path
  works without the access: which is what the test does to leave nothing behind.
- macOS 15 added `/usr/bin/trash`. It is not used because macOS 14 has none and
  two paths for one platform is one more than this needs.

#### Windows: `IFileOperation`, with a sink that refuses a delete

`SHFileOperation`, and the `Microsoft.VisualBasic.FileIO` wrapper over it that
most "send to recycle bin" snippets use, both **delete** an item the bin will not
take -- too large for it, on a drive with no bin, a network share -- silently,
under exactly the flags that keep them from opening a dialog. That is the one
outcome the contract rules out. `IFileOperation` calls its progress sink before
each delete, with `TSF_DELETE_RECYCLE_IF_POSSIBLE` set only where the item will be
recycled; the sink returns `E_ABORT` for any item without it, so the operation
stops with the item where it was, and `trash()` says Windows would have deleted it
for good. `PostDeleteItem` hands back the item in the bin, which is the path
`trash()` resolves with.

- **Reached through Windows PowerShell and a few lines of C#.** `powershell.exe`
  at its fixed path under `%SystemRoot%`, not a `PATH` lookup: Windows searches
  the working directory first, and a `powershell.exe` dropped there would run.
  `-STA`, because the shell's COM objects want a single-threaded apartment. The
  script goes as `-EncodedCommand` and the path as an environment variable, so
  nothing in a name is ever read as code, and the answer is JSON with everything
  past ASCII escaped, so nothing rests on the console's code page. Compiling the
  C# with `Add-Type` costs about a second each call, which is a delete a person
  asked for, not a loop.
- The interfaces are declared in vtable order and none may be dropped: COM
  interop checks nothing else.
- Paths past `MAX_PATH` are not supported; the shell does not take them.

#### Linux and every other Unix: the freedesktop.org spec, written out

`gio trash` would do it, and a server or a container does not have `gio`.
`freedesktop.ts` is the spec with nothing but `node:fs`:

- **The home trash is `$XDG_DATA_HOME/Trash`, read through `baseDir()`,** so a
  relative or empty value is ignored as the XDG rules in `paths.ts` say, and the
  default is `~/.local/share` through the same rule. Not `paths.data()`: that is
  cached for the process, and it is the platform's data directory, which on a Mac
  is not where a freedesktop trash goes. Read per call, so `XDG_DATA_HOME` is how
  a test, or anybody, points it at another trash.
- **Anything on another device goes to its own mount's trash.** The top of the
  mount is found by walking up while the device stays the same, rather than read
  from `/proc/mounts`, which is Linux's alone. Then the spec's two methods in its
  order: `$top/.Trash/$uid` where an administrator made a `.Trash` that is a real
  directory with the sticky bit, and `$top/.Trash-$uid` otherwise, made `0700` and
  required to be the user's own. A `.Trash` that is a link or lacks the bit is
  someone else's and is skipped, as the spec says. Where neither can be used --
  a read-only mount -- it throws.
- **The sticky bit is `0o1000`, written out.** `fs.constants` does not export
  `S_ISVTX`, so `mode & constants.S_ISVTX` is `0` and every `.Trash` failed it:
  the first run of the tests found it.
- **The `.trashinfo` is made first, with `O_EXCL`, and that is what reserves the
  name.** The spec has two programs trashing at once agree through it. A name
  whose `files/` entry is taken anyway is skipped too, and the info file made for
  it removed; a move that fails removes its info file. Names go `a.txt`,
  `a.2.txt`, `a.3.txt`: the number before the extension so the copy still opens
  with what opened the original.
- **`Path=` is URL-escaped per segment with `encodeURIComponent()`,** whose
  unreserved set is RFC 2396's exactly, so a newline in a name cannot end the
  line. Absolute in the home trash, relative to the top of the mount in a mount's
  trash, as the spec prefers. The parent is resolved first, so the path recorded
  is one the item can go back to. `DeletionDate=` is local time with no zone, the
  spec's own format.
- **The top of a mount is refused,** found as the one item whose device is not
  its parent's: moving it is unmounting it.
- The optional `directorysizes` cache is not written. The spec makes it
  optional, and a file manager that wants it recomputes a missing entry.

#### Tested on all three, and nothing left behind

`test/trash.test.ts`. The freedesktop half runs on macOS and Linux against a
trash inside a directory the test made, and makes a directory "another device" by
handing the trash a device function, since a test cannot mount anything; the
public `trash()` is run as Linux the same way, with `XDG_DATA_HOME` stubbed. The
platform's own trash is used on macOS and Windows only, once for a file -- a name
with spaces, quotes and more than ASCII among them -- and once for a directory,
and each test removes exactly the path `trash()` reported, in a `finally`, along
with the `$I` record beside it on Windows. Nothing in the suite moves anything it
did not make.
