import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/unpack-build-output.mjs` is the member filter between the publish
 * workflow's `build` job, which runs every devDependency, and its `publish`
 * job, which holds the npm token. Run as the workflow runs it: from the
 * checkout's root, with the download directory as its one argument.
 *
 * The archives are written here byte by byte rather than with a `tar` binary,
 * because most of what the script must refuse -- a symlink, a `..`, a bad
 * checksum -- is something a well-behaved `tar` will not write, and something
 * a compromised `build` job can.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = resolve(repo, 'scripts/unpack-build-output.mjs');

interface Member {
  name: string;
  type?: string;
  data?: string;
  magic?: string;
  checksum?: number;
}

function header({ name, type = '0', data = '', magic = 'ustar\u000000', checksum }: Member) {
  const block = Buffer.alloc(512);
  // a name longer than the 100-byte field goes into the 155-byte prefix
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  block.write(base, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${Buffer.byteLength(data).toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write(type, 156);
  block.write(magic, 257);
  block.write(prefix, 345, 155, 'utf8');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${(checksum ?? sum).toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function archive(members: Member[], trailer = Buffer.alloc(1024)): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    parts.push(header(member));
    const data = Buffer.from(member.data ?? '');
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(trailer);
  return Buffer.concat(parts);
}

const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'sigil-unpack-case-'));
  try {
    writeFileSync(join(probe, 'Case'), '');
    return existsSync(join(probe, 'case'));
  } finally {
    rmSync(probe, { force: true, recursive: true });
  }
})();

let root: string;
let checkout: string;
let download: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-unpack-'));
  checkout = join(root, 'checkout');
  download = join(root, 'download');
  mkdirSync(join(checkout, 'packages/sigil'), { recursive: true });
  writeFileSync(join(checkout, 'packages/sigil/package.json'), '{"name":"@ttylabs/sigil"}');
  writeFileSync(join(checkout, '.npmrc'), 'save-exact=true\n');
  mkdirSync(download);
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

function unpack(bytes: Buffer) {
  writeFileSync(join(download, 'build-output.tar'), bytes);
  const result = spawnSync(process.execPath, [script, download], {
    cwd: checkout,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  return { status: result.status, stdout: result.stdout };
}

const dist: Member[] = [
  { name: 'packages/sigil/dist/', type: '5' },
  { name: 'packages/sigil/dist/index.mjs', data: 'export {};\n' },
];

/** Asserts the archive was refused and that the checkout is as it started. */
function expectRefused(bytes: Buffer, reason: string | RegExp) {
  const { status, stdout } = unpack(bytes);
  expect(status).toBe(1);
  expect(stdout).toMatch(reason);
  expect(stdout).toContain('nothing was unpacked');
  expect(existsSync(join(checkout, 'packages/sigil/dist'))).toBe(false);
  expect(readFileSync(join(checkout, '.npmrc'), 'utf8')).toBe('save-exact=true\n');
}

describe('unpacking the build output', () => {
  it('should unpack regular files and directories under dist and registry', () => {
    const { status, stdout } = unpack(
      archive([
        ...dist,
        { name: 'packages/sigil/dist/chunks/a.mjs', data: 'export const a = 1;\n' },
        { name: 'packages/sigil/registry/spinner.json', data: '{}' },
      ])
    );

    expect(stdout).toBe('unpacked 3 files into packages/sigil/dist, packages/sigil/registry\n');
    expect(status).toBe(0);
    expect(readFileSync(join(checkout, 'packages/sigil/dist/index.mjs'), 'utf8')).toBe(
      'export {};\n'
    );
    expect(readFileSync(join(checkout, 'packages/sigil/dist/chunks/a.mjs'), 'utf8')).toBe(
      'export const a = 1;\n'
    );
    expect(readFileSync(join(checkout, 'packages/sigil/registry/spinner.json'), 'utf8')).toBe('{}');
  });

  it('should read a name long enough to need the ustar prefix', () => {
    const name = `packages/sigil/dist/${'d'.repeat(90)}/${'f'.repeat(60)}.mjs`;
    const { status } = unpack(archive([...dist, { name, data: 'x' }]));

    expect(status).toBe(0);
    expect(readFileSync(join(checkout, name), 'utf8')).toBe('x');
  });

  it('should refuse a member that would replace the checkout .npmrc', () => {
    // the shape the review reproduced: a project `.npmrc` sending the token to
    // a proxy in plain text
    expectRefused(
      archive([
        ...dist,
        {
          name: '.npmrc',
          data: 'registry=http://registry.npmjs.org/\nproxy=http://127.0.0.1:47911/\n',
        },
      ]),
      '::error::refused ".npmrc" is not under packages/<pkg>/dist or packages/<pkg>/registry'
    );
  });

  it('should refuse a manifest and the workspace file', () => {
    expectRefused(
      archive([...dist, { name: 'packages/sigil/package.json', data: '{"name":"evil"}' }]),
      '"packages/sigil/package.json" is not under'
    );
    expectRefused(
      archive([...dist, { name: 'pnpm-workspace.yaml', data: 'packages: []' }]),
      '"pnpm-workspace.yaml" is not under'
    );
  });

  it.each([
    ['1', 'a hard link'],
    ['2', 'a symlink'],
    ['3', 'a character device'],
    ['4', 'a block device'],
    ['6', 'a FIFO'],
    ['x', 'a pax header'],
    ['g', 'a global pax header'],
    ['L', 'a GNU long name'],
  ])('should refuse type %s, which is %s', (type) => {
    expectRefused(
      archive([...dist, { name: 'packages/sigil/dist/link', type }]),
      `"packages/sigil/dist/link" is not a regular file or a directory (type "${type}")`
    );
  });

  it.each([
    ['packages/sigil/dist/../../../.npmrc', 'has an empty, `.` or `..` segment'],
    ['packages/sigil/dist/./x', 'has an empty, `.` or `..` segment'],
    ['packages/sigil/dist//x', 'has an empty, `.` or `..` segment'],
    ['/packages/sigil/dist/x', 'is an absolute path'],
    ['packages\\sigil\\dist\\x', 'contains a backslash'],
    ['packages/sigil/dist/a\nb', 'contains a control character'],
    ['packages/sigil/distx/x', 'is not under'],
    ['packages/other/dist/x', 'is under packages/other, which is not a package in the checkout'],
  ])('should refuse the name %j', (name, reason) => {
    expectRefused(archive([...dist, { name, data: 'x' }]), reason);
  });

  it('should refuse a file that appears twice, or where a directory goes', () => {
    expectRefused(
      archive([...dist, { name: 'packages/sigil/dist/index.mjs', data: 'second' }]),
      '"packages/sigil/dist/index.mjs" appears more than once'
    );
    expectRefused(
      archive([...dist, { name: 'packages/sigil/dist/index.mjs/x', data: 'x' }]),
      'is inside "packages/sigil/dist/index.mjs", which is a file'
    );
  });

  it('should refuse a directory and a file of the same name', () => {
    expectRefused(
      archive([
        ...dist,
        { name: 'packages/sigil/dist/x/', type: '5' },
        { name: 'packages/sigil/dist/x', data: 'x' },
      ]),
      '"packages/sigil/dist/x" is both a file and a directory'
    );
  });

  it('should refuse a package directory that is a link to another', () => {
    // a link would make a write under it land wherever it points; a junction
    // on Windows, which needs no privilege and reads as a link to lstat
    symlinkSync(join(checkout, 'packages/sigil'), join(checkout, 'packages/linked'), 'junction');

    expectRefused(
      archive([{ name: 'packages/linked/dist/x', data: 'x' }]),
      '"packages/linked/dist/x" is under packages/linked, which is not a package in the checkout'
    );
  });

  // two names a case-insensitive file system reads as one pass every check and
  // fail on the second write, which is the one failure left after validation
  // that a test can provoke -- so it runs where the temp directory is one
  it.skipIf(!caseInsensitive)(
    'should say when a write fails after part of the archive is on disk',
    () => {
      const { status, stdout } = unpack(
        archive([
          ...dist,
          { name: 'packages/sigil/dist/A.mjs', data: 'a' },
          { name: 'packages/sigil/dist/a.mjs', data: 'b' },
        ])
      );

      expect(status).toBe(1);
      expect(stdout).toMatch(/EEXIST.*; unpacking failed partway, after 2 files\n$/);
      expect(stdout).not.toContain('nothing was unpacked');
    }
  );

  it('should refuse a header that is not POSIX ustar or has a bad checksum', () => {
    expectRefused(archive([{ ...dist[0], magic: 'ustar  \u0000' }, dist[1]]), 'is not POSIX ustar');
    expectRefused(archive([dist[0], { ...dist[1], checksum: 1 }]), 'has a bad checksum');
  });

  it('should refuse an archive with data after its end, or with no end', () => {
    expectRefused(
      archive(dist, Buffer.concat([Buffer.alloc(1024), Buffer.from('more')])),
      'has data after its end-of-archive blocks'
    );
    expectRefused(archive(dist, Buffer.alloc(0)), 'ends without its two zero blocks');
  });

  it('should refuse an output directory the checkout already has', () => {
    mkdirSync(join(checkout, 'packages/sigil/dist'));
    const { status, stdout } = unpack(archive(dist));

    expect(status).toBe(1);
    expect(stdout).toBe(
      '::error::packages/sigil/dist already exists in the checkout; nothing was unpacked\n'
    );
  });

  it('should refuse a download that is not exactly one file', () => {
    writeFileSync(join(download, 'second.tar'), '');
    expectRefused(archive(dist), 'should hold exactly one file, and holds 2 entries');
  });

  it.skipIf(process.platform === 'win32')('should read what tar --format=ustar writes', () => {
    const source = join(root, 'source');
    mkdirSync(join(source, 'packages/sigil/dist/chunks'), { recursive: true });
    writeFileSync(join(source, 'packages/sigil/dist/index.mjs'), 'export {};\n');
    writeFileSync(join(source, 'packages/sigil/dist/chunks/a.mjs'), 'a');
    const tar = join(download, 'build-output.tar');
    const made = spawnSync('tar', ['--format=ustar', '-cf', tar, 'packages/sigil/dist'], {
      cwd: source,
      encoding: 'utf8',
    });
    expect(made.status).toBe(0);

    const result = spawnSync(process.execPath, [script, download], {
      cwd: checkout,
      encoding: 'utf8',
    });

    expect(result.stdout).toBe('unpacked 2 files into packages/sigil/dist\n');
    expect(readFileSync(join(checkout, 'packages/sigil/dist/chunks/a.mjs'), 'utf8')).toBe('a');
  });
});
