import { __ } from '../i18n/index.js';
import { execFile } from 'node:child_process';

/**
 * Runs a program with an argument list -- never through a shell, so a path in an
 * argument is one argument whatever is in it -- and settles with what it wrote.
 *
 * @param file - The program, absolute.
 * @param args - Its arguments.
 * @param env - Variables to add to the environment it inherits.
 * @returns Its standard output.
 * @throws If it could not start or exited with a failure, with what it said.
 */
export function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const said = stderr.trim() || stdout.trim() || err.message;
          reject(new Error(__`${file} failed: ${said}`, { cause: err }));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
