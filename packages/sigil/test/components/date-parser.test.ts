import { date } from '../../src/components/date.js';
import { transformValue } from '../../src/util/transform.js';
import { screenSetup, tick } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

// the prompt cannot reach a date the parser refuses -- it clamps first -- so the
// only way to show the answer comes from the parser is to replace the parser and
// see what the prompt asks it and what it does with the reply
vi.mock('../../src/util/transform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/util/transform.js')>()),
  transformValue: vi.fn(),
}));

describe('date() and the parser', () => {
  it('should build the answer with the parser, from local ISO text and the `date` type', async () => {
    const sentinel = new Date(1234567);
    vi.mocked(transformValue).mockReturnValue(sentinel);

    const ui = screenSetup();
    const answer = date({
      initial: new Date(2024, 5, 15, 13, 45, 30),
      message: 'When?',
      seconds: true,
      terminal: ui.terminal,
    });
    await tick();
    ui.stdin.send('\r');

    expect(await answer).toBe(sentinel);
    // no offset: the parser reads that as a local time, which is what is documented
    expect(transformValue).toHaveBeenCalledWith('2024-06-15T13:45:30', 'date');
  });

  it('should show the parser refusing a value as the error line, not a throw', async () => {
    vi.mocked(transformValue).mockImplementation(() => {
      throw new Error('Invalid date: "nope"');
    });

    const ui = screenSetup();
    const answer = date({
      initial: new Date(2024, 5, 15),
      message: 'When?',
      terminal: ui.terminal,
    });
    await tick();
    ui.stdin.send('\r');
    await tick();

    expect(ui.log.join('\n')).to.contain('Invalid date: "nope"');
    ui.stdin.send('\u0003');
    await expect(answer).rejects.toThrow('Cancelled');
  });
});
