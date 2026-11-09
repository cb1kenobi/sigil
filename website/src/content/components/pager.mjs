import { page } from '@ttylabs/sigil/components/pager';

const changelog = Array.from(
  { length: 120 },
  (_, i) => `- ${['Fixed', 'Added', 'Changed'][i % 3]} entry ${120 - i}`
).join('\n');

await page(`# CHANGELOG\n\n${changelog}`, { lineNumbers: true });
