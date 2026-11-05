import { copyText } from '../src/lib/clipboard.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, navigator: g.navigator };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
});

function stub(key: 'document' | 'navigator', value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
}

/** Just enough of a document for the textarea fallback. */
function fakeDocument(copies: boolean | 'throw') {
  const written: string[] = [];
  const area = {
    remove() {},
    select() {},
    setAttribute() {},
    style: {},
    value: '',
  };
  return {
    written,
    doc: {
      activeElement: null,
      body: { append: () => {} },
      createElement: () => area,
      execCommand(command: string) {
        if (copies === 'throw') {
          throw new Error('nope');
        }
        written.push(`${command}:${area.value}`);
        return copies;
      },
      getSelection: () => null,
    },
  };
}

describe('copyText()', () => {
  it('should use the Clipboard API when it is there', async () => {
    const written: string[] = [];
    stub('navigator', {
      clipboard: { writeText: async (text: string) => void written.push(text) },
    });

    assert.equal(await copyText('npm test'), true);
    assert.deepEqual(written, ['npm test']);
  });

  it('should fall back to a selected textarea when the API refuses', async () => {
    const { doc, written } = fakeDocument(true);
    stub('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    stub('document', doc);

    assert.equal(await copyText('npm test'), true);
    assert.deepEqual(written, ['copy:npm test']);
  });

  it('should fall back when the API is not there at all, as on an insecure origin', async () => {
    const { doc } = fakeDocument(true);
    stub('navigator', {});
    stub('document', doc);

    assert.equal(await copyText('x'), true);
  });

  it('should say false, and not throw, when nothing can copy', async () => {
    stub('navigator', {});
    stub('document', fakeDocument(false).doc);
    assert.equal(await copyText('x'), false);

    stub('document', fakeDocument('throw').doc);
    assert.equal(await copyText('x'), false);

    stub('document', undefined);
    assert.equal(await copyText('x'), false);
  });
});
