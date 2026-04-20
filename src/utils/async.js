// Attach a last-resort logger to fire-and-forget promise chains so a throw
// inside a `.catch()` handler (DB writes, broadcasts) still produces a
// breadcrumb instead of surfacing only as an unhandledRejection. The global
// process handler in server.js is the fallback; this gives the log a label.
export function logAsync(promise, label) {
  return promise.catch((err) => {
    console.error(`[async:${label}]`, err?.stack || err);
  });
}
