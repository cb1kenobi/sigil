import { REMOVAL_TIMEOUT, removeTempDirs } from './temp.js';
import { afterAll } from 'vitest';

// a setup file runs before every test file, so this hook is registered on each
// of them and removes what that file made once it has finished, with a budget
// that fits a Windows runner rather than vitest's default
afterAll(removeTempDirs, REMOVAL_TIMEOUT);
