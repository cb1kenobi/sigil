/**
 * Reading a GitHub Actions workflow, for the two test files that assert on one.
 *
 * `cli.test.ts` holds this repository's own workflows to a set of rules and
 * `new.test.ts` holds the release workflow `sigil new` scaffolds to the same
 * ones, and until SIG-608 each read the YAML its own way -- so a rule one of
 * them could see, the other could only partly. Two shapes were the proof: a
 * job-level key placed **after** the steps was swallowed by the last step's
 * lines, so a secret there was attributed to a step that is allowed to have
 * one, and a step that opens with `- run:` has no `name:` for anything keyed by
 * name to find. This is the one reader, and the one definition of each check
 * built on it.
 *
 * Read line by line rather than through a YAML parser, which this package does
 * not have and which a test of a file's _text_ does not want: a parser answers
 * what the file means, and what these rules ask is where a line sits. The
 * shapes understood are the ones the two workflows use -- a `jobs:` map, a
 * `steps:` sequence, block scalars under `run:` -- and a workflow outside them
 * is a reason to extend this rather than to trust what it says. A flow-style
 * step (`- { run: ... }`), a quoted key (`- "run": ...`) and an anchor are not
 * read, and nothing here refuses them.
 */

/** One step of a job. */
export interface Step {
  /** The step's lines, from its `- ` to the line before the next step. */
  lines: string[];
  /**
   * Its `name:`, or what stands in for one: a step with no name -- `- run: ...`
   * or `- uses: ...` -- is labelled by that first line, so it can be told apart
   * and reported rather than collapsing into the empty string.
   */
  name: string;
}

/** One job of a workflow. */
export interface Job {
  /** The job's lines after `steps:`, which is where a job-level key placed last sits. */
  after: string[];
  /** The job's lines before `steps:`: `needs`, `permissions`, `env`, `outputs`, `strategy`. */
  head: string[];
  /** Every line of the job, in order. */
  lines: string[];
  name: string;
  steps: Step[];
}

/** A workflow, as lines. */
export interface Workflow {
  jobs: Map<string, Job>;
  /**
   * Every line outside every job -- the triggers, `permissions`, `env`, and a
   * top-level key after `jobs:`, which is as much the whole workflow's as one
   * before it.
   */
  outside: string[];
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === '';
const isComment = (line: string) => /^\s*#/.test(line);

/**
 * The lines of a text that are code: every line but a YAML comment.
 *
 * A comment saying `archive: false` is not the setting, and a comment is where
 * both files' own explanations of every one of these lines live. What is not a
 * comment is a `#` line **inside a block scalar**, which is the script's text:
 * the shell reads it as one, and GitHub expands a `${{ }}` in it before the
 * shell ever does, so it stays.
 */
function codeLines(text: string): string[] {
  const kept: string[] = [];
  // the key's indent while a block scalar is open, otherwise undefined
  let scalar: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (scalar !== undefined) {
      if (isBlank(line) || indentOf(line) > scalar) {
        kept.push(line);
        continue;
      }
      scalar = undefined;
    }
    if (isComment(line)) continue;
    kept.push(line);
    // `|`, `>`, and an indent digit and a chomp sign in either order, then maybe a comment
    const open = /^(\s*)(-\s+)?[\w.-]+:\s*[|>](?:[+-]?\d*|\d*[+-])\s*(?:#.*)?$/.exec(line);
    if (open) scalar = (open[1] as string).length + (open[2]?.length ?? 0);
  }
  return kept;
}

/** A step's label: its `name:`, else its first line, trimmed. */
function labelOf(lines: string[], itemIndent: number): string {
  for (const line of lines) {
    const name = /^(\s*)(-\s+)?name:\s*(.*)$/.exec(line);
    // only the step's own key, not a `name:` under its `with:`
    if (name && (name[1] as string).length + (name[2]?.length ?? 0) === itemIndent + 2) {
      return name[3] as string;
    }
  }
  return (lines[0] ?? '').trim();
}

/** Splits a job's lines at its `steps:` into what is before, the steps, and what is after. */
function readJob(name: string, lines: string[], jobIndent: number): Job {
  const at = lines.findIndex((line) => new RegExp(`^ {${jobIndent + 2}}steps:\\s*$`).test(line));
  if (at < 0) return { after: [], head: lines, lines, name, steps: [] };

  const stepsIndent = jobIndent + 2;
  let end = at + 1;
  let itemIndent: number | undefined;
  for (; end < lines.length; end++) {
    const line = lines[end] as string;
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    // a key at `steps:`'s own indent -- or less -- is the job's again; a
    // sequence may sit at the key's indent, and a `- ` there is still a step
    if (indent < stepsIndent || (indent === stepsIndent && !line.trimStart().startsWith('- '))) {
      break;
    }
    itemIndent ??= indent;
  }

  const steps: Step[] = [];
  let current: string[] | undefined;
  for (const line of lines.slice(at + 1, end)) {
    if (itemIndent !== undefined && indentOf(line) === itemIndent && /^\s*- /.test(line)) {
      steps.push({ lines: (current = []), name: '' });
    }
    current?.push(line);
  }
  for (const step of steps) step.name = labelOf(step.lines, itemIndent ?? 0);

  return { after: lines.slice(end), head: lines.slice(0, at), lines, name, steps };
}

/**
 * Reads a workflow's text.
 *
 * @param text - The file.
 * @returns Its jobs, and the lines outside them.
 */
export function readWorkflow(text: string): Workflow {
  const lines = codeLines(text);
  const outside: string[] = [];
  const raw = new Map<string, string[]>();
  let jobIndent: number | undefined;
  let inJobs = false;
  let current: string[] | undefined;

  for (const line of lines) {
    if (isBlank(line)) {
      current?.push(line);
      continue;
    }
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      current = undefined;
      outside.push(line);
      continue;
    }
    if (!inJobs) {
      outside.push(line);
      continue;
    }
    jobIndent ??= indentOf(line);
    if (indentOf(line) === jobIndent) {
      // a header may be quoted or carry a comment; one that is neither read is
      // refused, because its lines would otherwise belong to no job and no check
      const name = /^\s*(["']?)([\w-]+)\1:\s*(?:#.*)?$/.exec(line)?.[2];
      if (name === undefined) throw new Error(`Unrecognized job header: ${line.trim()}`);
      raw.set(name, (current = []));
    } else if (current) current.push(line);
    else outside.push(line);
  }

  const jobs = new Map<string, Job>();
  for (const [name, body] of raw) jobs.set(name, readJob(name, body, jobIndent ?? 2));
  return { jobs, outside };
}

/**
 * Every `run:` value in some lines, including the lines of a block scalar under it.
 *
 * A key's block ends at the first line indented no deeper than the key itself,
 * and for `- run:` the key sits two columns right of the dash -- which is what
 * a step that opens with `run:` needs and the reason this is not a regex for
 * `^\s+run:`.
 *
 * @param lines - Any of a workflow's lines: a step's, a job's, or all of them.
 * @returns One string per `run:`, the inline value first.
 */
export function runBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    const match = /^(\s*)(-\s+)?run:(.*)$/.exec(line);
    if (!match) return;
    const key = (match[1] as string).length + (match[2]?.length ?? 0);
    const block = [match[3] as string];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (!isBlank(next) && indentOf(next) <= key) break;
      block.push(next);
    }
    blocks.push(block.join('\n'));
  });
  return blocks;
}

/** Every line of a workflow, jobs and all, but the job headers themselves. */
export function allLines(workflow: Workflow): string[] {
  return [...workflow.outside, ...[...workflow.jobs.values()].flatMap((job) => job.lines)];
}

/**
 * The lines matching `pattern` that are not inside a step.
 *
 * The question the per-step checks cannot ask: they name which steps may read
 * a token, so a line that is in none -- a job's `env:` before its steps or
 * after them, the workflow's own, a key after `jobs:` -- is invisible to them
 * unless something asks it separately, and it is the shape that gives **every**
 * step the token.
 *
 * @param workflow - The workflow.
 * @param pattern - What to look for.
 * @returns One description per line, naming where it sits.
 */
export function outsideSteps(workflow: Workflow, pattern: RegExp): string[] {
  const where = (place: string, lines: string[]) =>
    lines.filter((line) => pattern.test(line)).map((line) => `${place}: ${line.trim()}`);
  return [
    ...where('workflow', workflow.outside),
    ...[...workflow.jobs.values()].flatMap((job) => [
      ...where(`job ${job.name}, before its steps`, job.head),
      ...where(`job ${job.name}, after its steps`, job.after),
    ]),
  ];
}

/**
 * The steps whose `run:` holds an expression.
 *
 * An expression is pasted into the script text before the shell parses it, so
 * a value holding a quote becomes shell; the safe form passes it through `env`
 * and reads it as a variable. Asked of **every** `run:`, an inline `- run: ...`
 * one included, which is what makes this one answer for both files.
 *
 * @param workflow - The workflow.
 * @returns One description per step, empty when none does.
 */
export function expressionsInRun(workflow: Workflow): string[] {
  const found = [...workflow.jobs.values()].flatMap((job) =>
    job.steps
      .filter((step) => runBlocks(step.lines).some((block) => block.includes('${{')))
      .map((step) => `job ${job.name}, step ${step.name}`)
  );
  // and every `run:` the file has, whether or not the reader placed it in a
  // step -- a `steps:` line the reader does not recognize parses as no steps,
  // and the per-step answer above would then be empty over a file full of them
  const all = runBlocks(allLines(workflow)).filter((block) => block.includes('${{'));
  if (all.length > found.length) found.push('a run block outside any step');
  return found;
}

/**
 * The steps whose lines match `pattern`.
 *
 * @param workflow - The workflow.
 * @param pattern - What to look for.
 * @returns The names of the steps, in order.
 */
export function stepsMatching(workflow: Workflow, pattern: RegExp): string[] {
  return [...workflow.jobs.values()].flatMap((job) =>
    job.steps.filter((step) => step.lines.some((line) => pattern.test(line))).map((s) => s.name)
  );
}

/**
 * A copy of a workflow with a secret in a job-level `env:` placed **after** its
 * steps, the last key of the last job. For the tests of the checks: a check
 * that cannot see this has a hole the shape fits through.
 *
 * @param text - A workflow in which the last job's last key is `steps:`.
 * @returns The text, with the key added.
 */
export function withSecretAfterSteps(text: string): string {
  const out = `${text.trimEnd()}\n    env:\n      SABOTAGE: \${{ secrets.SABOTAGE }}\n`;
  if (readWorkflow(out).jobs.size === 0) throw new Error('No job to add a key to');
  return out;
}

/**
 * A copy of a workflow with one more step, which opens with `- run:` and
 * holds an expression in its inline value.
 *
 * @param text - A workflow in which the last job's last key is `steps:`.
 * @returns The text, with the step added.
 */
export function withInlineRunExpression(text: string): string {
  const out = `${text.trimEnd()}\n      - run: echo \${{ github.ref_name }}\n`;
  if (readWorkflow(out).jobs.size === 0) throw new Error('No job to add a step to');
  return out;
}
