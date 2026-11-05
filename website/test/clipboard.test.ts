import { copyText } from '../src/lib/clipboard.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const globals = globalThis as Record<string, unknown>;
const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };

function stub(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function fakeDocument(execCommand: (command: string) => boolean) {
  const appended: unknown[] = [];
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute() {},
    select() {},
    setSelectionRange() {},
    remove() {
      appended.pop();
    },
  };
  return {
    textarea,
    appended,
    document: {
      body: { appendChild: (node: unknown) => appended.push(node) },
      activeElement: null,
      createElement: () => textarea,
      execCommand,
    },
  };
}

afterEach(() => {
  delete globals.document;
  if (saved.navigator) {
    Object.defineProperty(globalThis, 'navigator', saved.navigator);
  }
});

describe('copyText', () => {
  it('uses the async clipboard when there is one', async () => {
    const written: string[] = [];
    stub('navigator', {
      clipboard: { writeText: async (text: string) => void written.push(text) },
    });

    assert.equal(await copyText('npx @ttylabs/cli new my-cli'), true);
    assert.deepEqual(written, ['npx @ttylabs/cli new my-cli']);
  });

  it('falls back to a hidden textarea when the clipboard rejects', async () => {
    stub('navigator', {
      clipboard: {
        writeText: async () => {
          throw new DOMException('denied', 'NotAllowedError');
        },
      },
    });
    const fake = fakeDocument(() => true);
    stub('document', fake.document);

    assert.equal(await copyText('hello'), true);
    assert.equal(fake.textarea.value, 'hello');
    assert.equal(fake.appended.length, 0, 'the textarea is removed again');
  });

  it('falls back when there is no clipboard at all', async () => {
    stub('navigator', {});
    const commands: string[] = [];
    const fake = fakeDocument((command) => (commands.push(command), true));
    stub('document', fake.document);

    assert.equal(await copyText('hello'), true);
    assert.deepEqual(commands, ['copy']);
  });

  it('resolves false rather than throwing when nothing works', async () => {
    stub('navigator', {});
    const fake = fakeDocument(() => {
      throw new Error('blocked');
    });
    stub('document', fake.document);
    assert.equal(await copyText('hello'), false);

    const refused = fakeDocument(() => false);
    stub('document', refused.document);
    assert.equal(await copyText('hello'), false);
  });

  it('resolves false with no document either', async () => {
    stub('navigator', {});
    assert.equal(await copyText('hello'), false);
  });
});
