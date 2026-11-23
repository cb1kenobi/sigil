import { generateKeyPairSync, sign } from 'node:crypto';

/**
 * A certificate for `127.0.0.1`, made in memory, so a test can serve HTTPS
 * without reaching the network and without a key committed to the repository.
 *
 * Node can make a key pair and cannot make a certificate, and `openssl` is not
 * on every runner's `PATH`, so the certificate is written out as DER by hand: a
 * version 3 certificate, one extension that matters (`subjectAltName` with the
 * address), signed with the key it holds. Each piece is a tag, a length and its
 * content, which is what the helpers below are. It is valid for a day on either
 * side of now and for nothing but that address.
 *
 * Trust is the caller's: write `cert` to a file and point `NODE_EXTRA_CA_CERTS`
 * at it for a spawned process, or pass it as `ca` to a request made in this one.
 *
 * @returns The certificate and its private key, both PEM.
 */
export function selfSigned(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const algorithm = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = sequence(set(sequence(oid('2.5.4.3'), tagged(0x0c, Buffer.from('127.0.0.1')))));
  const day = 24 * 60 * 60 * 1000;
  const subjectAltName = sequence(
    oid('2.5.29.17'),
    tagged(0x04, sequence(tagged(0x87, Buffer.from([127, 0, 0, 1]))))
  );
  const basicConstraints = sequence(
    oid('2.5.29.19'),
    tagged(0x04, sequence(tagged(0x01, Buffer.from([0xff]))))
  );

  const body = sequence(
    tagged(0xa0, tagged(0x02, Buffer.from([2]))), // version 3
    tagged(0x02, Buffer.from([1])), // serial number
    algorithm,
    name,
    sequence(utc(Date.now() - day), utc(Date.now() + day)),
    name,
    publicKey.export({ format: 'der', type: 'spki' }),
    tagged(0xa3, sequence(subjectAltName, basicConstraints))
  );

  const signature = sign('sha256', body, privateKey);
  const certificate = sequence(
    body,
    algorithm,
    tagged(0x03, Buffer.concat([Buffer.from([0]), signature]))
  );

  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  };
}

/** A length, as DER writes it: one byte under 128, otherwise a count and the bytes. */
function length(size: number): Buffer {
  if (size < 128) {
    return Buffer.from([size]);
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One element: its tag, its length and its content. */
function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

/** A `SEQUENCE` of the elements given. */
function sequence(...parts: Buffer[]): Buffer {
  return tagged(0x30, Buffer.concat(parts));
}

/** A `SET` of the elements given. */
function set(...parts: Buffer[]): Buffer {
  return tagged(0x31, Buffer.concat(parts));
}

/** An object identifier, from its dotted form. */
function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let more = Math.floor(arc / 128); more > 0; more = Math.floor(more / 128)) {
      groups.unshift((more & 0x7f) | 0x80);
    }
    bytes.push(...groups);
  }
  return tagged(0x06, Buffer.from(bytes));
}

/** A `UTCTime`, to the second. */
function utc(ms: number): Buffer {
  const text = new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tagged(0x17, Buffer.from(`${text}Z`));
}

/** DER as PEM, in 64-column lines. */
function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
