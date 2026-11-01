import { removeTempDirs } from './temp.js';
import { afterAll } from 'vitest';

// a setup file runs before every test file, so this hook is registered on each
// of them and removes what that file made once it has finished
afterAll(removeTempDirs);

// the suite drives the drawn prompts, and the variable turns every one of them
// into lines -- so a developer who uses a screen reader, and is the person most
// likely to have it exported, would see hundreds of prompt tests fail. The tests
// of the line forms stub it themselves
delete process.env.SIGIL_ACCESSIBLE;
