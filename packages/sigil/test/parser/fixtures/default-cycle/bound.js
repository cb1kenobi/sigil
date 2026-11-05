// A regression here does not fail, it hangs: every load resolves without
// leaving the microtask queue, so the event loop never turns and no test
// timeout can fire. Each module's `parse` hook counts the times it has been
// dispatched and throws long before that matters, so a broken guard fails.
let dispatched = 0;

export const bound = {
  parse() {
    if (++dispatched > 50) {
      throw new Error('unbounded default chain');
    }
  },
};
