import { resultDetail } from '../src/components/search/result-detail.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('drops a leading title that the excerpt repeats, and the bare name after it', () => {
  // an option's indexed text is its title, then its name again, then what it does
  const detail = resultDetail(
    'sigil build --out',
    'sigil build --out --out Where the bundle goes, relative to the app'
  );
  assert.deepEqual(detail, { text: 'Where the bundle goes, relative to the app' });
});

test('drops the title even when the bare name is absent, as for a guide section', () => {
  assert.deepEqual(resultDetail('Option values', 'Option values An option takes one value.'), {
    text: 'An option takes one value.',
  });
});

test('drops the bare name once, so a description that starts with it keeps it', () => {
  // a command's body is `sigil check check Check an app...`
  assert.deepEqual(resultDetail('sigil check', 'sigil check check Check an app.'), {
    text: 'Check an app.',
  });
});

test('drops the title from under the highlighting Pagefind put on it', () => {
  assert.deepEqual(resultDetail('sigil new', '<mark>sigil</mark> new new Create a new app'), {
    text: 'Create a new app',
  });
});

test('keeps the highlighted html when the excerpt does not start with the title', () => {
  const excerpt = 'the <mark>bundle</mark> goes here';
  assert.deepEqual(resultDetail('sigil build --out', excerpt), { html: excerpt });
});

test('matching is case insensitive', () => {
  assert.deepEqual(resultDetail('Install', 'install Something.'), { text: 'Something.' });
});

test('returns null rather than an empty line when nothing survives the trim', () => {
  assert.equal(resultDetail('sigil', 'sigil'), null);
});

test('returns null for a record with no excerpt', () => {
  assert.equal(resultDetail('Anything', ''), null);
});

test('a title with regex characters is matched literally', () => {
  assert.deepEqual(resultDetail('a.b', 'axb Something.'), { html: 'axb Something.' });
});

test('shows the characters Pagefind escaped, once the title is trimmed off', () => {
  assert.deepEqual(
    resultDetail('Run it', '<mark>Run</mark> it npm run dev -- &lt;arguments&gt; runs &amp; more'),
    { text: 'npm run dev -- <arguments> runs & more' }
  );
});

test('leaves the escaping alone in the html branch, which is drawn as html', () => {
  const excerpt = 'the &lt;arguments&gt; <mark>runs</mark>';
  assert.deepEqual(resultDetail('Run it', excerpt), { html: excerpt });
});
