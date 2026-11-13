#!/usr/bin/env node

/**
 * Unpacks the publish workflow's build output into the checkout, and refuses
 * anything that is not a build output.
 *
 * `node scripts/unpack-build-output.mjs <download dir>`, from the repository
 * root. The directory must hold exactly one file: the archive the `build` job
 * uploaded, written with `tar --format=ustar`.
 *
 * The `build` job runs every devDependency's code, with passwordless sudo, so
 * everything about that archive is under its control: every member's name and
 * every member's type. Extracting it with `tar -xf` over the checkout let it
 * overwrite the tracked `.npmrc` and point the publish, token and all, at any
 * registry or proxy it liked. So this reads the archive itself rather than
 * handing it to a `tar` binary, and nothing is written until every member has
 * passed:
 *
 * - each header is POSIX ustar with a correct checksum, and the archive ends
 *   in zero blocks with nothing after them;
 * - each member is a regular file or a directory, never a symlink, hard link,
 *   device, FIFO, or a GNU or pax extension header;
 * - each name is relative, has no empty, `.` or `..` segment, no backslash and
 *   no control character, and is `packages/<pkg>/dist` or
 *   `packages/<pkg>/registry` or something under one of them, for a `<pkg>`
 *   the checkout already has as a real directory with a `package.json`.
 *
 * Writing is then exclusive: no output directory may already exist, and each
 * file is created with `wx`, so a member can neither land on something the
 * checkout holds nor overwrite an earlier member.
 *
 * What this cannot do is judge the bytes of `dist/` and `registry/`
 * themselves. `build` produced them, so `build` decides what this release of
 * each package contains -- that is inherent in publishing what was built.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK = 512;
const OUTPUT = /^packages\/([^/]+)\/(dist|registry)(?:\/|$)/;

/** A NUL-terminated field, as a string. */
function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** An octal number field, refusing GNU's base-256 form and anything else. */
function octal(header, start, length, what) {
  const text = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`a header has a ${what} that is not an octal number: ${JSON.stringify(text)}`);
  }
  return Number.parseInt(text, 8);
}

function checksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

/**
 * Why `name` may not be unpacked, or `undefined` if it may. `root` is the
 * checkout, which decides what counts as a package.
 */
export function refusal(name, root) {
  if (name.startsWith('/')) return 'is an absolute path';
  if (name.includes('\\')) return 'contains a backslash';
  if (/\p{Cc}/u.test(name)) return 'contains a control character';
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'has an empty, `.` or `..` segment';
  }
  const match = OUTPUT.exec(name);
  if (!match) return 'is not under packages/<pkg>/dist or packages/<pkg>/registry';
  const pkg = join(root, 'packages', match[1]);
  try {
    if (!lstatSync(pkg).isDirectory() || !lstatSync(join(pkg, 'package.json')).isFile()) {
      return `is under packages/${match[1]}, which is not a package in the checkout`;
    }
  } catch {
    return `is under packages/${match[1]}, which is not a package in the checkout`;
  }
  return undefined;
}

/**
 * Every member of a ustar archive, validated. Throws on the first header that
 * is malformed; returns refusals rather than throwing for members that are
 * well formed but not allowed, so that all of them can be reported at once.
 */
export function readArchive(archive, root) {
  const members = [];
  const refused = [];
  let offset = 0;

  while (true) {
    if (offset + BLOCK > archive.length) {
      throw new Error('the archive ends without its two zero blocks');
    }
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + 2 * BLOCK > archive.length) {
        throw new Error('the archive ends without its two zero blocks');
      }
      if (!archive.subarray(offset).every((byte) => byte === 0)) {
        throw new Error('the archive has data after its end-of-archive blocks');
      }
      break;
    }

    if (field(header, 257, 6) !== 'ustar' || field(header, 263, 2) !== '00') {
      throw new Error(`the header at byte ${offset} is not POSIX ustar`);
    }
    if (octal(header, 148, 8, 'checksum') !== checksum(header)) {
      throw new Error(`the header at byte ${offset} has a bad checksum`);
    }

    const prefix = field(header, 345, 155);
    const base = field(header, 0, 100);
    const raw = prefix ? `${prefix}/${base}` : base;
    const size = octal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156]);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new Error(`${JSON.stringify(raw)} is cut short`);
    }

    let kind;
    if (type === '0' || type === '\0') kind = 'file';
    else if (type === '5') kind = 'directory';

    const name = kind === 'directory' ? raw.replace(/\/$/, '') : raw;
    const why =
      kind === undefined
        ? `is not a regular file or a directory (type ${JSON.stringify(type)})`
        : kind === 'directory' && size !== 0
          ? 'is a directory with data'
          : refusal(name, root);

    if (why) refused.push(`${JSON.stringify(raw)} ${why}`);
    else members.push({ kind, name, data: archive.subarray(dataStart, dataEnd) });

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  // Two members for one file, or a file where another member needs a
  // directory, would fail halfway through writing; refuse them up front so
  // that a refusal always means nothing was written.
  const files = new Set();
  for (const { kind, name } of members) {
    if (kind !== 'file') continue;
    if (files.has(name)) refused.push(`${JSON.stringify(name)} appears more than once`);
    files.add(name);
  }
  for (const { name } of members) {
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/');
      if (files.has(parent)) {
        refused.push(
          `${JSON.stringify(name)} is inside ${JSON.stringify(parent)}, which is a file`
        );
      }
    }
  }
  for (const { kind, name } of members) {
    if (kind === 'directory' && files.has(name)) {
      refused.push(`${JSON.stringify(name)} is both a file and a directory`);
    }
  }

  return { members, refused };
}

/** Writes validated members under `root`. Nothing it writes may exist yet. */
export function writeMembers(members, root) {
  const outputs = new Set(members.map(({ name }) => OUTPUT.exec(name)[0].replace(/\/$/, '')));
  for (const output of outputs) {
    let exists = true;
    try {
      lstatSync(join(root, output));
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`${output} already exists in the checkout`);
  }

  // Everything above refuses before a byte is written. What can still fail
  // here is the file system itself -- a full disk, a name too long for it, or
  // two names a case-insensitive one reads as the same -- and then part of
  // the archive is already on disk, which the message has to say.
  let files = 0;
  try {
    for (const { kind, name, data } of members) {
      const path = join(root, name);
      if (kind === 'directory') {
        mkdirSync(path, { recursive: true });
      } else {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, data, { flag: 'wx', mode: 0o644 });
        files++;
      }
    }
  } catch (err) {
    throw new PartwayError(`${err.message}; unpacking failed partway, after ${files} files`);
  }
  return { files, outputs: [...outputs].sort() };
}

/** A failure after some members were written, so "nothing was unpacked" is false. */
export class PartwayError extends Error {}

export function unpack(dir, root) {
  const entries = readdirSync(dir);
  if (entries.length !== 1) {
    throw new Error(`${dir} should hold exactly one file, and holds ${entries.length} entries`);
  }
  const path = join(dir, entries[0]);
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);

  const { members, refused } = readArchive(readFileSync(path), root);
  if (refused.length > 0) return { refused };
  if (members.length === 0) throw new Error('the archive holds nothing to unpack');
  return writeMembers(members, root);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node scripts/unpack-build-output.mjs <download dir>');
    process.exit(2);
  }
  try {
    const result = unpack(dir, process.cwd());
    if (result.refused) {
      for (const line of result.refused) console.log(`::error::refused ${line}`);
      console.log('::error::nothing was unpacked');
      process.exitCode = 1;
    } else {
      console.log(`unpacked ${result.files} files into ${result.outputs.join(', ')}`);
    }
  } catch (err) {
    const tail = err instanceof PartwayError ? '' : '; nothing was unpacked';
    console.log(`::error::${err.message}${tail}`);
    process.exitCode = 1;
  }
}
