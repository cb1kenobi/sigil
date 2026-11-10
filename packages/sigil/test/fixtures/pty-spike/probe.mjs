// SIG-288 spike, temporary: measures @lydell/node-pty on whatever CI runs this,
// and prints one JSON line. Reverted before the PR is ready.
import { spawn } from '@lydell/node-pty';

const child = String.raw`
  const say = (s) => process.stdout.write('@@' + s + '@@\n');
  say('TTY ' + process.stdin.isTTY + ' ' + process.stdout.isTTY + ' ' + process.stdout.columns + 'x' + process.stdout.rows);
  let seen = '';
  const report = (how) => {
    const size = process.stdout.columns + 'x' + process.stdout.rows;
    if (size !== seen) { seen = size; say('SIZE ' + how + ' ' + size); }
  };
  process.stdout.on('resize', () => report('event'));
  setInterval(() => { process.stdout._refreshSize?.(); report('poll'); }, 50);
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    if (buf.includes('quit')) { say('GOT quit'); setTimeout(() => process.exit(7), 100); }
  });
`;

const strip = (s) =>
  s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '');
const started = performance.now();
const result = { platform: process.platform, arch: process.arch, node: process.version, steps: [] };
const mark = (step) => result.steps.push([step, Math.round(performance.now() - started)]);

let out = '';
const p = spawn(process.execPath, ['-e', child], {
  cols: 80,
  cwd: process.cwd(),
  env: process.env,
  name: 'xterm-256color',
  rows: 24,
});
mark('spawned');

const waitFor = (re) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out on ' + re + ' with ' + JSON.stringify(strip(out)))),
      15000
    );
    const check = () => {
      const m = strip(out).match(re);
      if (m) {
        clearTimeout(timer);
        sub.dispose();
        resolve(m);
      }
    };
    const sub = p.onData(check);
    check();
  });

const exited = new Promise((resolve) => p.onExit(resolve));
p.onData((d) => (out += d));

try {
  const tty = await waitFor(/@@TTY (\S+) (\S+) (\S+)@@/);
  result.tty = tty.slice(1);
  mark('tty');
  p.resize(100, 40);
  const size = await waitFor(/@@SIZE (\w+) 100x40@@/);
  result.resizedBy = size[1];
  mark('resized');
  p.write('quit\r');
  await waitFor(/@@GOT quit@@/);
  mark('wrote');
  result.exit = await exited;
  mark('exited');

  // kill: a child that never exits on its own
  const q = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cols: 80, rows: 24 });
  const qExit = new Promise((resolve) => q.onExit(resolve));
  setTimeout(() => q.kill(), 200);
  result.killed = await qExit;
  mark('killed');
} catch (err) {
  result.error = String(err?.stack ?? err);
}
console.log(JSON.stringify(result));
process.exit(0);
