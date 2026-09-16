/**
 * Logs a value without letting the logger become the problem.
 *
 * `log()` runs its argument through `util.inspect` whether or not `DEBUG` is
 * enabled, so a throwing getter or a hostile `inspect.custom` hook could throw
 * from inside the error path. Nothing logged there is worth failing over.
 *
 * @param log - The debug logger to write to.
 * @param value - The value to log.
 */
export function safeLog(log: (...args: unknown[]) => void, value: unknown): void {
	try {
		log(value);
	} catch {
		// a value that cannot even be inspected has nothing to tell us
	}
}
