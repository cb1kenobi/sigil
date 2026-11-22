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
  `cause.message`; both examples read it that way. For an errno error the paths
  node appends are cut from the reason, and the original error is the `cause`'s
  own `cause`; any other error is the `cause` itself. A program that fails says
  what it wrote to stderr, or its exit code -- never `execFile`'s `Command
  failed:` line, which is the whole command, the path included. A path that is not there is
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
  past ASCII escaped, so nothing rests on the console's code page. The C# is
  compiled once and kept, below.
- The interfaces are declared in vtable order and none may be dropped: COM
  interop checks nothing else.
- Paths past `MAX_PATH` are not supported; the shell does not take them.

#### Windows: the helper is compiled once, and sealed to the user who compiled it

Every call used to compile the C# with `Add-Type` (SIG-490). It is compiled on a
call that finds no usable copy, and the assembly is kept under `paths.cache()`
as `sigil/trash-<16 hex>.bin`, named for the SHA-256 of the C#.

- **The file is the assembly sealed with DPAPI for the current user, with the
  source's hash as the entropy; it is not a DLL with a hash beside it.** A hash
  kept next to the file is written by whoever writes the file, so it proves the
  file is intact and nothing about who put it there. A seal made **for the
  user** can be made only by that user -- or by SYSTEM, an administrator or a
  domain backup-key holder, who are not what this is guarding against -- and
  unsealing it checks its own MAC: a file another unprivileged user sealed for
  themselves -- in a cache base `XDG_CACHE_HOME` pointed somewhere shared, say --
  a plain DLL, a truncated seal, and a real seal made for another
  version's C# all fail to unseal, and each of those is a rebuild over it, never
  an error.
- **A seal made for the machine is refused before it is unsealed, because
  `Unprotect()`'s `'CurrentUser'` limits nothing.** DPAPI applies the scope only
  when sealing: a blob sealed with `CRYPTPROTECT_LOCAL_MACHINE` unseals for every
  user on the machine, whatever scope the caller names, and the entropy is
  `'sigil-trash ' + sha256(CSHARP)`, which is public. So another local user who
  can write to the cache path could seal the assembly of their choosing with
  `ProtectedData.Protect($bytes, $entropy, 'LocalMachine')`, put it at
  `trash-<hash>.bin`, and have the victim's next `trash()` unseal it without error
  and run it as the victim. The script reads the blob's flags field first and
  treats a blob that is under 44 bytes, or has the `0x4` bit set, as a miss. The
  field is the `dwFlags` of the blob header -- a version (4 bytes), the provider
  GUID (16), the master key version (4), the master key GUID (16), then the flags
  at byte 40 -- and `0x4` is `CRYPTPROTECT_LOCAL_MACHINE`. The layout is
  Microsoft's `CRYPTPROTECT_*` flag values plus the community's reverse
  engineering of the blob (mimikatz, dpapick); it is not a documented format, so
  the tests read it back off a real blob on the runner (`'0'` for a user seal,
  `'4'` for a machine one) rather than trusting it.

  What this does **not** claim is that the flags field is covered by the blob's
  MAC, because nothing here establishes that. The guard does not need it to be: an
  attacker who clears the bit in a machine blob still has a blob whose master key
  is the machine's, and `Unprotect()` without the flag is expected to look for
  that key among the user's own and fail -- which is a rebuild too. That is an
  expectation and not a source, so `should not run a machine seal with the machine
  bit cleared` plants exactly that blob and demands a rebuild: if some Windows
  unseals it, that test fails on that runner and the guard is open.

- **A seal cannot stop a process running as the same user, which can seal
  anything it likes:** the entropy is the source's hash and not a secret. For an
  install the user can write -- a global npm install under `%APPDATA%`, a
  project's `node_modules` -- that process can already rewrite the sigil the C#
  comes from, so no file it can write is a boundary against it. Where it does
  matter is an app installed where the user cannot write, run **elevated** by the
  same user: a medium-integrity process can plant a sealed file that the next
  elevated `trash()` loads at high integrity. Before this change it could only
  race the compile in the user's temp directory; now the plant persists. Not
  closed, because UAC is not a security boundary in Microsoft's own terms, and
  skipping the cache whenever the process is elevated would make every elevated
  app pay the compile on every call to guard against a process that, for the
  usual per-user install, could already rewrite the app.
- **The build directory is trusted the way `Add-Type` trusted it,** and what it
  produced is then sealed. `%TEMP%` is the user's own by default; a `TMP` pointed
  at a directory others can write into lets them swap the DLL between the compile
  and the read, which `Add-Type` was open to as well -- the difference is that the
  swap is now kept.
- **One read, and the load is from that buffer.** The file is read once into
  memory, that buffer is what is unsealed, and the unsealed bytes are what
  `Assembly.Load(byte[])` is handed -- never `LoadFrom()` on the path -- so
  there is no window between the check and the load for the file to be swapped
  in, and nothing reads it twice. A file over 1 MiB is not read.
- **Building is the compile `Add-Type` always did, by hand.** `CSharpCodeProvider`
  into a directory of its own, named with a fresh GUID under the user's temp
  directory, which is where `Add-Type` compiled too; the DLL is read back into
  memory and the directory removed. By hand because `Add-Type` loads what it
  builds and hands back no bytes to seal.
- **A cache that cannot be written costs the compile and never the trash.**
  Saving goes to a fresh name opened `CreateNew`, which refuses anything already
  there -- a link included -- and is then moved over the cache file. Every
  failure on the way, no cache base, DPAPI unavailable, a directory where the
  file should be, a file where the directory should be, is swallowed: the
  assembly is already in memory and the item is recycled with it. Two calls
  racing each build and one move wins.
- **Nothing removes an old version's file.** Two apps on different sigil
  versions would remove each other's and both pay the compile every call; each
  is a few kilobytes.
- **The C# reaches PowerShell in an environment variable, not in the command.**
  The encoded command was 24,792 characters with the C# in it and Windows stops
  at 32,767; the script that caches would not have fitted beside it.
- **`recycle()` reports what became of the helper** -- `hit`, `saved`, `built`, `compiled` (a refused load, below),
  or `none` when the call failed first -- because that is the whole difference
  between one call and the next, and the Windows tests in `test/trash.test.ts`
  pin each case with a cache they name: compiled once and loaded after; garbage,
  a truncated seal and another source's seal each rebuilt; a real, unsealed
  assembly with the helper's own name, which would answer without moving the
  item, rebuilt rather than run -- the one forgery `Assembly.Load()` would not
  refuse by itself, and the case that fails if a miss ever fell back to loading
  the raw bytes; the same stub sealed for the machine, which unseals without
  error -- the plant unseals it as the user first, so the rebuild is the guard's
  doing -- and is rebuilt rather than run, and again with the machine bit cleared;
  two calls racing on an empty cache; an unwritable cache
  compiling every call and still recycling. `test/trash-windows.test.ts` pins
  the key, the file name and what PowerShell is handed, on every platform.
- **A refused load falls back to loading the library from a file, in a second
  PowerShell, and the item is still recycled** (SIG-517).
  `Assembly.Load(byte[])` from a script handed over `-EncodedCommand` is also what
  a reflective loader looks like, and .NET 4.8 shows such a load to AMSI; Defender
  on the runner lets it through, and an endpoint product may refuse it. Neither
  of the two obvious fallbacks avoids the call. Compiling in memory is no way
  round it, because the unwritable-cache path loads its freshly compiled bytes
  with the same call. And `Add-Type -TypeDefinition`, which is what every call did
  before SIG-490, compiles with `GenerateInMemory` and CodeDom then does
  `Assembly.Load(byte[])` on what it read back -- found by review round 1, from
  .NET's reference source and PowerShell's `AddType.cs`, not measured on a
  machine that refuses. So the fallback is the one path that loads from a file:
  the same hand compile into a directory of its own, then
  `Assembly.LoadFrom()` of the library, which an endpoint product sees as an
  ordinary file load.

  Only the load of the bytes just compiled counts as a refusal. A failed load of a
  **cached** file is indistinguishable from a file that is not ours and is a
  rebuild as it always was, and a refusal there reaches the same load after the
  rebuild. The script answers `loadRefused` and stops **before** `Recycle()` runs,
  so nothing has moved and asking again cannot move the item twice, and before the
  cache is written, so a helper that cannot be loaded is never sealed and kept.
  `recycle()` then asks once more with the compile script, which reads and
  writes no cache and reports `compiled`; a refusal answered to that is thrown,
  never retried.

  - **That is a trust trade, and a deliberate one.** `LoadFrom()` opens the file
    itself, so the one-read-and-load-from-that-buffer rule above does not hold for
    this path: the library sits in a directory under the user's temp directory,
    named with a fresh GUID, between the compile and the load -- which is what
    `Add-Type` always trusted, and a `TMP` others can write into was open to it
    equally. Nothing is sealed, because nothing is kept for another call to trust.
  - **The library cannot be removed by the call that loaded it,** since a loaded
    file is locked until the process ends. The compile mode first removes the
    directories an earlier call left -- named `sigil-trash-` and 32 hex digits, and
    more than an hour old, so a concurrent call's is never touched -- which is a
    few kilobytes per call in an environment that already pays for a second
    PowerShell.
  - **It is asked afresh on every call and not remembered for the process,** so
    such an environment pays a second PowerShell start (about 350 ms on the runner)
    per trash. A remembered refusal would be module state the tests could not reset
    without reimporting the module.
  - **A refusal of the library's own load is answered the same way,** by the
    compile mode's own `catch`, so that `recycle()` throws `The helper could not
    be loaded` with the reason rather than PowerShell's `Exception calling
    "LoadFrom"`. A compile that fails is still an `error`: it is not a refusal.
  - **Directories can be left behind, and the sweep is the only thing that
    removes them.** Only a compile-mode call sweeps, so if the refusal stops --
    an exclusion is added -- the last ones stay until something else clears the
    temp directory; a compile or load that fails leaves its own; and a loop
    trashing N items leaves N for the hour. The sweep is pinned by a Windows test
    with a backdated directory, a fresh one and one named like ours but not made
    by us.
  - **A first run that prints no JSON is retried once, with the compile script,
    and a run that printed anything is not** (SIG-598). The two are told apart by
    what the script does: it answers in JSON for everything it can reach, an error
    and a refusal to delete included, so a run that ends with none was stopped
    before it could say -- killed, or its text refused by a product that scans the
    script before it runs, which `Assembly.Load` in a script handed over
    `-EncodedCommand` is what such a scan looks for. A file that cannot be recycled
    is an `error` answer and is never asked twice, so the ordinary failure costs
    what it always did.

    The compile script is a **separate script** and not the same one with a mode
    in the environment (it was, in SIG-517): the retry is only worth making with
    text that holds none of the first's loading call, and `SIGIL_TRASH_MODE` is
    gone with it. It loads with `LoadFrom()`, so an exclusion on the bytes' load
    does not apply to it either.

    It is asked only **while the item is still where it was** (`lstat()`). The
    earlier reason for not retrying stands for a run killed after the move: the
    item is gone, a second run would be asked to move what is not there and report
    that as the failure, so there is none and the first failure is thrown -- which
    is the answer this had before, for a move that did happen. It cannot tell a
    move from the item having been removed by something else, and says the same
    for both. Not remembered for the process, for the reason a refusal is not.
    Once is the limit: a second run that prints nothing throws its own message, and
    one that answers is read like any answer. Pinned in `trash-windows.test.ts`
    with PowerShell replaced; no CI machine can stop or block the first script.

  - **What no test reaches is the script's own `catch` around the load,** since no
    runner can be made to refuse one. `trash-windows.test.ts` replaces PowerShell
    to pin the second ask, its script, its errors and that it stops there, and reads
    the script for the order -- the refusal caught before anything is kept, and
    the compile mode loading from a file, reading and writing no cache. The Windows
    jobs run the compile mode itself, asked for directly, and check that it
    recycles and neither reads nor writes the cache.

- The real-trash tests on a Windows runner go through `trash()` and so leave one
  such file in the runner's own cache, which is what a cache is for.

**Measured on the `windows-latest` runner, as of this change**, from a timing
test run in the suite and then removed, so each figure is under the suite's own
parallel load. The ticket said about a second a call, which is not what the
runner shows: compiling is about a tenth of a second there, and starting
PowerShell is most of the rest.

|                                  | node 22    | node 24    | node 26    |
| -------------------------------- | ---------- | ---------- | ---------- |
| PowerShell starting, nothing run | 324–342 ms | 320–340 ms | 207–214 ms |
| a call before, compiling         | 420–437 ms | 417–440 ms | 339–353 ms |
| after: first call, compiled      | 515 ms     | 495 ms     | 342 ms     |
| after: a call loading the cache  | 380–387 ms | 363–387 ms | 237–247 ms |
| after: no cache, compiling       | 482–489 ms | 513–514 ms | 309–327 ms |

"Before" and "after" are different runs on different runner instances, which is
why the no-cache row is not the "before" row: within one run, a call that loads
the cache is 60–150 ms faster than one that compiles, and 25–65 ms slower than
PowerShell doing nothing. What is left is PowerShell's own start, which a cache
cannot touch.

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

#### Review round 1: eight findings, four fixed

- **A `.Trash` another user made is not used.** The sticky bit stops other users
  renaming what is inside, never the directory's owner, so a `.Trash` made by
  someone else on a `1777` mount was one they could empty by renaming `$uid` out
  of it. It has to be owned by root or by the user now, which the spec does not
  ask and costs nothing: the next method is `.Trash-$uid`. No test, since a test
  cannot make a directory another user owns.
- **A trash whose `files/` or `info/` is a link is refused,** home trash
  included: `mkdir()` and `rename()` follow a link mid-path, so the item would go
  wherever it pointed and be reported trashed. `should refuse a trash whose
  files/ is a link`.
- **The `cause` of an errno error has no path in it.** Node ends the message with
  the paths, so the examples' toasts still printed the absolute path the `cause`
  exists to leave out. The original error is the `cause`'s own `cause`.
- **The disk usage example scans again when Windows does not say where** an item
  went, and folds case on Windows before asking whether it went under the root.
- Not fixed: the `files/` entry is checked and then renamed over, and POSIX
  `rename()` replaces a file, so a program that writes `files/<name>` without
  reserving its `.trashinfo` between the two can lose what it wrote. That
  program is breaking the spec, and `node:fs` has no `RENAME_NOREPLACE`.
- Not fixed: no timeout on the spawned `osascript` or PowerShell. A timeout would
  report a failure for a move that may still happen; `FOF_NO_UI` and
  `NSFileManager` open no dialog to wait on.
- Not fixed: a real-trash test whose `trash()` answers `''` on Windows leaves its
  item in the runner's bin, since there is no path to take back. The shell has
  answered with the path on every CI run.
- Not fixed: no test proves a copy-then-delete would be caught, since a test
  cannot make `EXDEV`. There is no copy in the code; every move is one `rename()`.

#### Review round 2, over round 1's fixes: seven findings, six fixed

- **The home trash itself may not be a link either:** round 1 checked `files/`
  and `info/` and not `Trash`. `should refuse a trash that is itself a link`.
- **Round 1's owner check refused the setup the shared `.Trash` is for.** Over NFS
  with root squashed, root's `.Trash` reads as `nobody`'s, and the mount's top is
  usually not writable, so `.Trash-$uid` cannot be made either. Another user's
  `.Trash` is now refused only where the top is writable by everyone -- where
  anyone could have made it -- and accepted otherwise, as the spec does.
  `should use another user's .Trash only where the top is not writable by all`
  pins both halves by asking as a uid that is not the user's.
- The `ENOENT` test read a Windows path as a regular expression; it is
  `toContain()` now.
- A program that failed with nothing on stderr reported `execFile`'s message,
  which is the command line with the path in it; it says the exit code instead.
- The package README says the result can be `''` on Windows, and the disk usage
  README says that case is scanned again.
- Not fixed: the disk usage example's case fold on Windows has no test. It needs
  the platform to be Windows while the app renders, and the fold is one
  `toLowerCase()`.
