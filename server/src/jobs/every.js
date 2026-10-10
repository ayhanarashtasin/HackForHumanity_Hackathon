// Runs `task` now and then every `minutes`, never overlapping itself. Failures are recorded, never thrown.
export function every(name, minutes, task) {
  let busy = false;

  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (error) {
      console.error(`[${name}] ${error.message}`);
    } finally {
      busy = false;
    }
  };

  run();
  const timer = setInterval(run, minutes * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
