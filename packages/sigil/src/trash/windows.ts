/**
 * The Windows Recycle Bin, through the shell's `IFileOperation`, which
 * PowerShell reaches through a few lines of C#.
 *
 * `IFileOperation` rather than `SHFileOperation` or the
 * `Microsoft.VisualBasic.FileIO` wrapper over it, because those **delete** an item
 * the bin will not take -- one too large for it, or on a drive with no bin, a
 * network share among them -- silently, under the flags that keep them from
 * opening a dialog. `IFileOperation` asks its progress sink before each delete and
 * says whether the item will be recycled; the sink here refuses any item that
 * would not be, so the operation stops with the item where it was.
 */

import { __ } from '../i18n/index.js';
import { cache } from '../paths.js';
import { run } from './spawn.js';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The C#: the three COM interfaces it needs, a sink that refuses a delete that
 * would not recycle, and the call. Interface methods are in vtable order, which
 * is the whole of what COM interop checks, so none may be dropped or reordered.
 */
const CSHARP = `using System;
using System.Runtime.InteropServices;
using System.Text;

namespace SigilTrash {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int hrResult);
    [PreserveSig] int PreRenameItem(uint dwFlags, IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostRenameItem(uint dwFlags, IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrRename, IShellItem psiNewlyCreated);
    [PreserveSig] int PreMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrMove, IShellItem psiNewlyCreated);
    [PreserveSig] int PreCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrCopy, IShellItem psiNewlyCreated);
    [PreserveSig] int PreDeleteItem(uint dwFlags, IShellItem psiItem);
    [PreserveSig] int PostDeleteItem(uint dwFlags, IShellItem psiItem, int hrDelete, IShellItem psiNewlyCreated);
    [PreserveSig] int PreNewItem(uint dwFlags, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostNewItem(uint dwFlags, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, uint dwFileAttributes, int hrNew, IShellItem psiNewItem);
    [PreserveSig] int UpdateProgress(uint iWorkTotal, uint iWorkSoFar);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }

  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    uint Advise(IFileOperationProgressSink pfops);
    void Unadvise(uint dwCookie);
    void SetOperationFlags(uint dwOperationFlags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
    void SetProgressDialog(IntPtr popd);
    void SetProperties(IntPtr pproparray);
    void SetOwnerWindow(IntPtr hwndOwner);
    void ApplyPropertiesToItem(IShellItem psiItem);
    void ApplyPropertiesToItems(IntPtr punkItems);
    void RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IFileOperationProgressSink pfopsItem);
    void RenameItems(IntPtr pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    void MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IFileOperationProgressSink pfopsItem);
    void MoveItems(IntPtr punkItems, IShellItem psiDestinationFolder);
    void CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, IFileOperationProgressSink pfopsItem);
    void CopyItems(IntPtr punkItems, IShellItem psiDestinationFolder);
    void DeleteItem(IShellItem psiItem, IFileOperationProgressSink pfopsItem);
    void DeleteItems(IntPtr punkItems);
    void NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, IFileOperationProgressSink pfopsItem);
    void PerformOperations();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
  }

  public class Sink : IFileOperationProgressSink {
    // TSF_DELETE_RECYCLE_IF_POSSIBLE: set when the item will go to the bin, and
    // missing when the delete would be for good
    const uint RECYCLE = 0x80;
    public bool Refused;
    public int Result;
    public string Where;
    public int PreDeleteItem(uint dwFlags, IShellItem psiItem) {
      if ((dwFlags & RECYCLE) == 0) {
        Refused = true;
        return unchecked((int)0x80004004); // E_ABORT
      }
      return 0;
    }
    public int PostDeleteItem(uint dwFlags, IShellItem psiItem, int hrDelete, IShellItem psiNewlyCreated) {
      Result = hrDelete;
      if (psiNewlyCreated != null) {
        try {
          string path;
          psiNewlyCreated.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
          Where = path;
        } catch (Exception) {
        }
      }
      return 0;
    }
    public int StartOperations() { return 0; }
    public int FinishOperations(int hrResult) { return 0; }
    public int PreRenameItem(uint dwFlags, IShellItem psiItem, string pszNewName) { return 0; }
    public int PostRenameItem(uint dwFlags, IShellItem psiItem, string pszNewName, int hrRename, IShellItem psiNewlyCreated) { return 0; }
    public int PreMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName) { return 0; }
    public int PostMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName, int hrMove, IShellItem psiNewlyCreated) { return 0; }
    public int PreCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName) { return 0; }
    public int PostCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName, int hrCopy, IShellItem psiNewlyCreated) { return 0; }
    public int PreNewItem(uint dwFlags, IShellItem psiDestinationFolder, string pszNewName) { return 0; }
    public int PostNewItem(uint dwFlags, IShellItem psiDestinationFolder, string pszNewName, string pszTemplateName, uint dwFileAttributes, int hrNew, IShellItem psiNewItem) { return 0; }
    public int UpdateProgress(uint iWorkTotal, uint iWorkSoFar) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }

  public static class Bin {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR |
    // FOF_NOERRORUI | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE: no dialog of any
    // kind, and the bin rather than a delete
    const uint FLAGS = 0x4 | 0x10 | 0x40 | 0x200 | 0x400 | 0x80000 | 0x100000;

    public static string Recycle(string path) {
      Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      IShellItem item;
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
      IFileOperation op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
      Sink sink = new Sink();
      op.SetOperationFlags(FLAGS);
      op.DeleteItem(item, sink);
      try {
        op.PerformOperations();
      } catch (COMException err) {
        if (!sink.Refused) {
          return Answer("error", err.Message);
        }
      }
      if (sink.Refused) {
        return Answer("refused", "");
      }
      if (sink.Result < 0) {
        return Answer("error", Marshal.GetExceptionForHR(sink.Result).Message);
      }
      if (op.GetAnyOperationsAborted()) {
        return Answer("error", "the operation was cancelled");
      }
      return Answer("path", sink.Where);
    }

    // JSON with everything past ASCII escaped, so nothing rests on the console's
    // code page
    public static string Answer(string key, string value) {
      StringBuilder out_ = new StringBuilder("{\\"" + key + "\\":");
      if (value == null) {
        out_.Append("null");
      } else {
        out_.Append('"');
        foreach (char c in value) {
          if (c == '"' || c == '\\\\') {
            out_.Append('\\\\').Append(c);
          } else if (c < 0x20 || c > 0x7e) {
            out_.AppendFormat("\\\\u{0:x4}", (int)c);
          } else {
            out_.Append(c);
          }
        }
        out_.Append('"');
      }
      return out_.Append('}').ToString();
    }
  }
}`;

/**
 * The PowerShell around it, which compiles the C# once per source and keeps the
 * assembly in the cache directory -- verified before it is loaded, and loaded
 * from the very bytes that were verified.
 *
 * `AGENTS.md` beside this file has the whole of the reasoning; in short:
 *
 * - The cached file is the assembly sealed with DPAPI for the current user, the
 *   entropy being the source's hash. Unsealing checks the seal's own MAC, so a
 *   file another user sealed for themselves, one sealed for another source, a
 *   truncated one or a plain DLL all fail to unseal -- and a failure is a
 *   rebuild, never an error.
 *   A hash kept beside the file would be written by whoever wrote the file.
 *   A seal made for the **machine** is refused before it is unsealed, from the
 *   flags field of the blob: DPAPI applies the scope only when sealing, so any
 *   user can seal for the machine and every user can unseal it.
 * - It is read once, into memory, and that buffer is what is unsealed and what
 *   `Assembly.Load()` is handed, so nothing can swap the file between the check
 *   and the load: the file is never opened a second time.
 * - Building writes the DLL into a directory of its own under the user's temp
 *   directory, which is where `Add-Type` always compiled, and reads it back the
 *   same way. Saving goes through a fresh name opened `CreateNew`, which refuses
 *   anything already at it, and every failure to save is swallowed: a cache that
 *   cannot be written costs the compile, as it always did, and never the trash.
 *
 * - A load that is refused is not the end of the call. `Assembly.Load(byte[])` is
 *   what an endpoint product may refuse, and `Add-Type` makes the same call
 *   itself, so the fallback loads from a file instead: a refusal of the freshly
 *   built bytes is answered as `loadRefused`, and `recycle()` asks again with a
 *   second script, which compiles into a directory of its own and `LoadFrom()`s
 *   the library, keeping and sealing nothing. The same second script is what a
 *   first run that printed nothing at all is retried with, since it holds none of
 *   the first's loading text.
 *
 * The path, the cache file, the key and the C# itself all come from the
 * environment rather than being spliced into the script, so nothing in a name
 * can be read as code -- and keeping the C# out of the command line is what
 * leaves it room under Windows' 32,767 characters. A failure anywhere, the C#
 * not compiling included, still answers in JSON.
 */
const HEAD = `$ErrorActionPreference = 'Stop'
$state = 'none'
function Compile([string]$dir) {
  $params = New-Object CodeDom.Compiler.CompilerParameters
  $params.GenerateInMemory = $false
  $params.OutputAssembly = Join-Path $dir 'SigilTrash.dll'
  $params.TempFiles = New-Object CodeDom.Compiler.TempFileCollection $dir, $false
  $built = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($params, [string]$env:SIGIL_TRASH_SOURCE)
  $failed = @($built.Errors | Where-Object { -not $_.IsWarning })
  if ($failed.Count) {
    throw [string]$failed[0]
  }
  $params.OutputAssembly
}
function Escape([string]$m) {
  ($m.ToCharArray() | ForEach-Object { if ([int]$_ -lt 32 -or [int]$_ -gt 126 -or $_ -eq '"' -or $_ -eq '\\') { '\\u{0:x4}' -f [int]$_ } else { [string]$_ } }) -join ''
}
try {
  $bin = $null
  $refused = $null
`;

const TAIL = `  if ($null -ne $refused) {
    [Console]::Out.Write('{"cache":"' + $state + '","answer":{"loadRefused":"' + (Escape $refused) + '"}}')
  } else {
    [Console]::Out.Write('{"cache":"' + $state + '","answer":' + $bin::Recycle([string]$env:SIGIL_TRASH_PATH) + '}')
  }
} catch {
  [Console]::Out.Write('{"cache":"' + $state + '","answer":{"error":"' + (Escape ([string]$_.Exception.Message)) + '"}}')
}
`;

const BYTES = `  $cache = [string]$env:SIGIL_TRASH_CACHE
  $entropy = [Text.Encoding]::UTF8.GetBytes('sigil-trash ' + $env:SIGIL_TRASH_KEY)
  $assembly = $null
  $sealer = $false
  if ($cache) {
    try {
      Add-Type -AssemblyName System.Security
      $sealer = $true
      $sealed = $null
      $file = New-Object IO.FileInfo $cache
      if ($file.Exists -and $file.Length -lt 1048576) {
        $sealed = [IO.File]::ReadAllBytes($cache)
      }
      if ($null -ne $sealed -and $sealed.Length -ge 44 -and ([BitConverter]::ToUInt32($sealed, 40) -band 4) -eq 0) {
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, 'CurrentUser')
        $assembly = [Reflection.Assembly]::Load($bytes)
        $state = 'hit'
      }
    } catch {
      $assembly = $null
    }
  }
  if (-not $assembly) {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('sigil-trash-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($dir)
    try {
      $bytes = [IO.File]::ReadAllBytes((Compile $dir))
    } finally {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
    try {
      $assembly = [Reflection.Assembly]::Load($bytes)
    } catch {
      $refused = [string]$_.Exception.Message
    }
    if ($null -eq $refused) {
      $state = 'built'
      if ($sealer) {
        $temp = $null
        try {
          $sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser')
          [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($cache))
          $temp = $cache + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
          $stream = New-Object IO.FileStream $temp, 'CreateNew', 'Write'
          try {
            $stream.Write($sealed, 0, $sealed.Length)
          } finally {
            $stream.Dispose()
          }
          if ([IO.File]::Exists($cache)) {
            [IO.File]::Delete($cache)
          }
          [IO.File]::Move($temp, $cache)
          $temp = $null
          $state = 'saved'
        } catch {
        } finally {
          if ($temp) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
          }
        }
      }
    }
  }
  if ($null -eq $refused) {
    $bin = $assembly.GetType('SigilTrash.Bin', $true)
  }
`;

const COMPILE = `  # a library that is loaded from its own file stays locked for as long as this
  # process lives, so it cannot be removed here; an earlier call's is, once it is
  # old enough that nothing can still be using it
  Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'sigil-trash-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^sigil-trash-[0-9a-f]{32}$' -and $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('sigil-trash-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($dir)
  $library = Compile $dir
  try {
    $assembly = [Reflection.Assembly]::LoadFrom($library)
    $bin = $assembly.GetType('SigilTrash.Bin', $true)
    $state = 'compiled'
  } catch {
    $refused = [string]$_.Exception.Message
  }
`;

/**
 * The script that loads the helper from its bytes, and the one that loads it from
 * a file. Two scripts rather than one with a switch in it, because the second is
 * what runs when the first was stopped before it answered, and a script that held
 * the first's `Assembly.Load` text would be stopped the same way.
 */
const SCRIPT = HEAD + BYTES + TAIL;
const COMPILE_SCRIPT = HEAD + COMPILE + TAIL;

/**
 * What became of the compiled helper on one call: loaded from the cache (`hit`),
 * compiled and kept (`saved`), compiled and not kept because the cache could not
 * be written (`built`), compiled and loaded from a file, and not kept, because
 * loading the bytes was refused (`compiled`), or nothing yet because the call
 * failed first (`none`).
 */
export type CacheState = 'built' | 'compiled' | 'hit' | 'none' | 'saved';

/**
 * How the helper is loaded: from bytes, which is what the cache needs and the
 * default, or from a file, which is what a refused load falls back to.
 */
export type LoadMode = 'bytes' | 'compile';

/** The C#'s own hash, computed once: what the cache file is named for and sealed to. */
let key: string | undefined;

/**
 * A source's key: SHA-256, in hex.
 *
 * `node:crypto` is asked for rather than imported, as `config/atomic.ts` asks for
 * it, since only a call on Windows needs it.
 */
export function keyOf(source: string): string {
  return process.getBuiltinModule('node:crypto').createHash('sha256').update(source).digest('hex');
}

/**
 * Where the compiled helper for a key is kept, under a cache base directory.
 *
 * Named for the key, so a newer sigil with different C# never reads an older
 * one's file; the seal is what proves it, and the name only keeps two versions
 * on one machine from overwriting each other. Nothing removes an old one: two
 * apps on different versions would remove each other's, and each is a few
 * kilobytes.
 *
 * @param base - The cache base, as `paths.cache()` answers; nothing for none.
 * @param hash - The source's key.
 * @returns The file, or nothing, in which case the helper is compiled every call.
 */
export function cacheFile(base: string | undefined, hash: string): string | undefined {
  return base ? join(base, 'sigil', `trash-${hash.slice(0, 16)}.bin`) : undefined;
}

/** Windows PowerShell, which every Windows this runs on has, at the path it always has. */
function powershell(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * Moves a file or a directory to the Recycle Bin.
 *
 * @param path - Absolute.
 * @returns Where it went: `$Recycle.Bin\<sid>\$R…`, beside the `$I…` file that
 *   says where it came from.
 * @throws If the bin would not take it, which leaves it where it was.
 */
export async function trashWindows(path: string): Promise<string> {
  key ??= keyOf(CSHARP);
  return (await recycle(path, cacheFile(cache(), key), key)).path;
}

type Reply = {
  answer?: { error?: string; loadRefused?: string; path?: string | null; refused?: string };
  cache?: CacheState;
};

/**
 * One PowerShell run, and what it printed.
 *
 * @returns The reply, or the error for a run that printed no JSON: one that failed
 *   to start, was killed, exited with a failure, or wrote something else.
 */
async function ask(
  path: string,
  file: string | undefined,
  hash: string,
  load: LoadMode
): Promise<Reply | Error> {
  let out: string;
  try {
    out = await run(
      powershell(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(load === 'compile' ? COMPILE_SCRIPT : SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        // set even when empty, so that one inherited from the caller's environment
        // cannot name a cache this call was not given
        SIGIL_TRASH_CACHE: file ?? '',
        SIGIL_TRASH_KEY: hash,
        SIGIL_TRASH_PATH: path,
        SIGIL_TRASH_SOURCE: CSHARP,
      }
    );
  } catch (err) {
    // only a run that failed is read: the other error below quotes what the script
    // printed, which can hold the item's own path
    return constrained((err as Error).message)
      ? new Blocked(
          __`PowerShell is in Constrained Language Mode, which cannot run the script that moves an item to the Recycle Bin`,
          { cause: err }
        )
      : (err as Error);
  }
  try {
    const reply = JSON.parse(out.trim());
    if (reply !== null && typeof reply === 'object') {
      return reply;
    }
  } catch {
    // not JSON
  }
  return new Error(__`PowerShell answered ${JSON.stringify(out.trim())}`);
}

/**
 * The run that PowerShell's Constrained Language Mode stopped: what `recycle()`
 * throws for it, so that it is told from every other failure by what it is and not
 * by text read a second time.
 */
class Blocked extends Error {}

/**
 * Whether the stderr of a failed run says PowerShell is in Constrained Language
 * Mode, which is what an application control policy (AppLocker, WDAC) puts it in.
 * Neither script can run there, so a second start is spent for nothing.
 *
 * Both scripts end in the same `catch`, which writes with `[Console]::Out.Write()`,
 * and that is a method call on a type CLM does not allow: every earlier failure is
 * caught by it, so the error that escapes is that one, with the id
 * `MethodInvocationNotSupportedInConstrainedLanguage`. `CannotCreateType...` is the
 * id `New-Object` of a compiler gets and is matched too, for a script that lets it
 * out. The **id** is read, because it is not translated and the sentence beside it
 * is.
 *
 * The text is normalised first, because PowerShell wraps a formatted error at the
 * width of the console buffer and each piece is its own CLIXML `<S S="Error">`
 * element -- an id that ends a 79 character line is split by any width under that.
 * The tags, the `_x000D_` escapes and every space are taken out, which joins the
 * pieces back; the match is then case sensitive and starts at a word boundary.
 */
function constrained(said: string): boolean {
  const text = said
    .replace(/<[^>]*>/g, '')
    .replace(/_x[0-9A-Fa-f]{4}_/g, '')
    .replace(/\s+/g, '');
  return /\b(?:MethodInvocationNotSupportedIn|CannotCreateType)ConstrainedLanguage/.test(text);
}

/** Whether the item is still where it was: `lstat()`, so a link is asked about and not its target. */
async function stillThere(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `trashWindows()` with the cache named rather than found, and saying what became
 * of it -- the seam the tests use, since what is cached is the whole of the
 * difference between one call and the next.
 *
 * When the helper's bytes cannot be loaded -- an endpoint product that refuses
 * `Assembly.Load(byte[])` -- it asks PowerShell again to compile the helper and
 * load it from a file, so the item is still recycled and the call costs a second PowerShell
 * start. A run that prints no JSON at all -- killed, or its script refused before it
 * ran -- is asked again the same way, once, while the item is still where it was;
 * a run that answers, an error included, never is. That is asked of every call in such an environment rather than
 * remembered, since a remembered refusal is module state a later call could not
 * see go away.
 *
 * @param path - Absolute.
 * @param file - Where the compiled helper is kept; nothing to compile it every call.
 * @param hash - The key the helper is sealed to.
 * @param load - `compile` to skip the bytes and the cache altogether, which is
 *   what the second ask is.
 * @returns Where the item went, and what became of the helper.
 * @throws If the bin would not take it, which leaves it where it was.
 */
export async function recycle(
  path: string,
  file: string | undefined,
  hash: string,
  load: LoadMode = 'bytes'
): Promise<{ cache: CacheState; path: string }> {
  const asked = await ask(path, file, hash, load);
  if (asked instanceof Error) {
    if (asked instanceof Blocked) {
      // neither script can run in this environment, so a second start would only
      // fail the same way
      throw asked;
    }
    // no JSON: the script never got to say what happened to the item, which a
    // script that ran to the end always does, an error included -- so it was
    // stopped, or its text was refused. Asked again once, with the script that has
    // none of the first's loading text, and only while the item is still where it
    // was: one that is gone was moved before the process was stopped, and asking
    // would report the move that happened as the failure
    if (load === 'bytes' && (await stillThere(path))) {
      return recycle(path, file, hash, 'compile');
    }
    throw asked;
  }
  const answer = asked.answer ?? {};
  if (answer.loadRefused !== undefined) {
    // nothing has run yet -- the load is before the move -- so asking again cannot
    // move the item twice; and there is nothing past the compile to fall back to
    if (load === 'bytes') {
      return recycle(path, file, hash, 'compile');
    }
    throw new Error(__`The helper could not be loaded: ${answer.loadRefused}`);
  }
  if (answer.refused !== undefined) {
    throw new Error(__`Windows would delete it for good rather than recycle it`);
  }
  if (answer.error !== undefined) {
    throw new Error(answer.error);
  }
  // recycled, but the shell did not say where: the item is in the bin, so this
  // is not a failure to report as one
  return { cache: asked.cache ?? 'none', path: answer.path || '' };
}
