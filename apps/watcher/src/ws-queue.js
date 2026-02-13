export const createDebouncedInFlightQueue = (delayMs, run) => {
  const inFlight = new Set();
  const pending = new Map();
  const timers = new Map();

  const schedule = (key) => {
    if (timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        const value = pending.get(key);
        if (!value) return;
        if (inFlight.has(key)) {
          schedule(key);
          return;
        }
        pending.delete(key);
        inFlight.add(key);
        Promise.resolve(run(value))
          .catch(() => undefined)
          .finally(() => {
            inFlight.delete(key);
            if (pending.has(key)) {
              schedule(key);
            }
          });
      }, delayMs)
    );
  };

  return {
    trigger: (key, value) => {
      pending.set(key, value);
      schedule(key);
    }
  };
};
