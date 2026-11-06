import { environment, run } from '../../../packages/cli/test/guides.ts';
import { StyledScreen } from './styled-screen.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the home page draws, run for real.
 *
 * Every terminal on the home page is something a program printed, with its
 * colour: the toolchain's own `--help`, the `todo` app the parser section shows
 * the source of, the prompts and components in the hero, the card previews and
 * the accessible-mode pair. This is where each one is produced, and
 * `capture-transcripts.ts` writes the result to
 * `src/transcripts/home/screens.json` -- the same mechanism, and the same
 * reasons, as the guides' captures beside it. `test/home-captures.test.ts`
 * runs this again and fails when the committed file is not what comes back, so
 * a change to a demo, a component, a command or the `todo` source cannot leave
 * the page showing output nobody produces any more.
 *
 * Four sources, and none of them is typed by hand:
 *
 * - the **scenes** in `home-scenes.mjs`, which are prompts driven through
 *   `createTestTerminal()` and components called with their real options, run
 *   as a child so that colour can be forced on the process;
 * - the **`todo` app** in `src/content/home/todo.mjs`, which is also the source
 *   the page shows, so the listing and the output cannot disagree;
 * - **shell completion**, which is the script `todo completion bash` prints,
 *   loaded into a real bash and asked what a tab would offer;
 * - **`sigil --help`**, from the built toolchain.
 */

/** The website's directory. */
const SITE = join(import.meta.dirname, '../..');

/** Where the `todo` app is, which is also what the page shows. */
export const TODO = join(SITE, 'src/content/home/todo.mjs');

/** The built toolchain, which is the only form that has its descriptions. */
const SIGIL = join(SITE, '../packages/cli/dist/sigil.mjs');

/** The width a captured command is run at. */
const COLUMNS = 80;

/**
 * The width `sigil --help` is run at: what fits the hero-sized terminal beside
 * it on the home page without a sideways scroll, at 14px. Help wraps its own
 * descriptions to the width it is given, so this is a real narrower screen and
 * not the same one cut off.
 */
const CLI_COLUMNS = 68;

/** One screen: the commands that were run on it, or the prompt that was drawn. */
export interface HomeScreen {
  readonly runs: readonly { readonly command?: string; readonly output: string }[];
  /** The columns it was drawn at, for the title bar. */
  readonly columns: number;
}

export interface HomeCapture {
  readonly screens: Readonly<Record<string, HomeScreen>>;
}

/** The environment a capture is run in: colour forced, everything else fixed. */
function env(columns = COLUMNS): NodeJS.ProcessEnv {
  return { ...environment([], {}), COLUMNS: String(columns), FORCE_COLOR: '1' };
}

/** What `home-scenes.mjs` prints. */
type Scenes = Record<string, { columns: number; kind: 'screen' | 'text'; output: string }>;

/** Runs the scenes as a child, with colour forced on the process. */
function scenes(): Promise<Scenes> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'home-scenes.mjs')], {
      cwd: SITE,
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`home-scenes.mjs exited ${code}:\n${stderr}`));
        return;
      }
      settle(JSON.parse(stdout) as Scenes);
    });
  });
}

/** What bash is asked to do, and the words it is asked about. */
const ASK = (script: string, words: string) =>
  [
    `. ${JSON.stringify(script)}`,
    `COMP_WORDS=(${words})`,
    'COMP_CWORD=$((${#COMP_WORDS[@]} - 1))',
    'COMP_LINE="${COMP_WORDS[*]}"',
    'COMP_POINT=${#COMP_LINE}',
    'COMPREPLY=()',
    '_todo',
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join('\n');

/** Runs bash on a script, answering its stdout. */
function bash(script: string): Promise<string> {
  return new Promise((settle, fail) => {
    const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.on('error', fail);
    child.on('close', () => settle(stdout));
  });
}

/**
 * What readline prints for a tab pressed twice: the candidates, sorted, in
 * columns that read down, each padded to the longest and two more.
 */
function listing(candidates: readonly string[]): string {
  const sorted = [...new Set(candidates)].sort();
  const width = Math.max(...sorted.map((it) => it.length)) + 2;
  const across = Math.max(1, Math.floor(COLUMNS / width));
  const down = Math.ceil(sorted.length / across);

  return Array.from({ length: down }, (_, row) =>
    Array.from({ length: across }, (_, column) => sorted[column * down + row])
      .filter((it) => it !== undefined)
      .map((it) => it.padEnd(width))
      .join('')
      .trimEnd()
  ).join('\n');
}

/**
 * Captures everything the home page draws.
 *
 * @returns The screens, by the name the page asks for.
 */
export async function captureHome(): Promise<HomeCapture> {
  if (!existsSync(SIGIL)) {
    throw new Error(
      'The home page captures `sigil --help` from the built toolchain, which is not built. ' +
        'Run `pnpm build` first.'
    );
  }

  const out: Record<string, HomeScreen> = {};

  for (const [id, scene] of Object.entries(await scenes())) {
    if (scene.kind === 'text') {
      out[id] = { columns: scene.columns, runs: [{ output: scene.output }] };
      continue;
    }
    const screen = new StyledScreen(scene.columns, 24);
    screen.write(scene.output);
    out[id] = { columns: scene.columns, runs: [{ output: screen.toSgr() }] };
  }

  const todo = async (command: string, argv: string[]) => ({
    command,
    output: (await run(join(TODO, '..'), ['todo.mjs', ...argv], env())).output,
  });

  out.parser = {
    columns: COLUMNS,
    runs: [await todo('todo --help', ['--help'])],
  };
  out.agent = {
    columns: COLUMNS,
    runs: [
      // stdin is not a terminal either way: `run()` spawns with it ignored, which
      // is `/dev/null`, so this is `< /dev/null` and not a stand-in for it
      await todo('todo add < /dev/null', ['add']),
      await todo('todo add "Renew passport"', ['add', 'Renew passport']),
    ],
  };

  const dir = mkdtempSync(join(tmpdir(), 'sigil-home-'));
  try {
    const script = join(dir, 'todo.bash');
    writeFileSync(script, `${(await todo('', ['completion', 'bash'])).output}\n`);

    const runs = [];
    for (const typed of ['', 'l']) {
      const candidates = (await bash(ASK(script, `todo ${JSON.stringify(typed)}`)))
        .split('\n')
        .filter(Boolean);
      runs.push({ command: `todo ${typed}⇥⇥`, output: listing(candidates) });
    }
    out.completion = { columns: COLUMNS, runs };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }

  out.cli = {
    columns: CLI_COLUMNS,
    runs: [
      {
        command: 'sigil --help',
        output: (await run(SITE, [SIGIL, '--help'], env(CLI_COLUMNS))).output,
      },
    ],
  };

  return { screens: out };
}
