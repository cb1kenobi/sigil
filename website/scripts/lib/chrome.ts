import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Just enough of the Chrome DevTools Protocol to drive a headless Chrome from a
 * script, over the `WebSocket` Node already has -- so the site's browser checks
 * need no Playwright and no Puppeteer, which would be a few hundred megabytes of
 * devDependency for what is a handful of protocol calls.
 *
 * The browser is whichever Chrome is installed: `CHROME` names one, and
 * otherwise the usual places on macOS and Linux are tried. None of this runs in
 * the test suite; it is for `scripts/check-pages.ts`, run by hand against a
 * served build.
 */

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** The Chrome to drive, or `undefined` when none is installed where we look. */
export function findChrome(): string | undefined {
  const named = process.env.CHROME;
  if (named) {
    return named;
  }
  return CANDIDATES.find((path) => existsSync(path));
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Listener = (params: Record<string, unknown>) => void;

/** One page's protocol connection. */
export class Page {
  #socket: WebSocket;
  #next = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<Listener>>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) {
          pending?.reject(new Error(message.error.message));
        } else {
          pending?.resolve(message.result);
        }
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
      }
    });
  }

  static async connect(url: string): Promise<Page> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Page(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  /** Resolves on the next `method` event. */
  once(method: string, timeout = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const set = this.#listeners.get(method) ?? new Set();
      this.#listeners.set(method, set);
      const timer = setTimeout(() => {
        set.delete(listener);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeout);
      const listener: Listener = (params) => {
        clearTimeout(timer);
        set.delete(listener);
        resolve(params);
      };
      set.add(listener);
    });
  }

  /** Evaluates an expression in the page and hands back its value, awaited and by value. */
  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send<{
      result: { value: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  close(): void {
    this.#socket.close();
  }
}

/** A headless Chrome, its profile in a temporary directory that `close()` removes. */
export class Browser {
  #process: ChildProcess;
  #profile: string;
  readonly origin: string;

  private constructor(process: ChildProcess, profile: string, origin: string) {
    this.#process = process;
    this.#profile = profile;
    this.origin = origin;
  }

  static async launch(executable: string): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), 'sigil-check-pages-'));
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    // Chrome writes the port it chose to this file once it is listening.
    const portFile = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
      if (Date.now() > deadline) {
        child.kill();
        rmSync(profile, { recursive: true, force: true });
        throw new Error('Chrome did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [port] = readFileSync(portFile, 'utf8').split('\n');
    return new Browser(child, profile, `http://127.0.0.1:${port}`);
  }

  async newPage(): Promise<Page> {
    const response = await fetch(`${this.origin}/json/new?about:blank`, { method: 'PUT' });
    const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
    return Page.connect(webSocketDebuggerUrl);
  }

  async close(): Promise<void> {
    const exited = new Promise((resolve) => this.#process.once('exit', resolve));
    this.#process.kill();
    await exited;
    rmSync(this.#profile, { recursive: true, force: true });
  }
}
