export type DebouncedInFlightQueue<T> = {
  trigger: (key: string, value: T) => void;
};

export const createDebouncedInFlightQueue = <T>(
  delayMs: number,
  run: (value: T) => Promise<void>
): DebouncedInFlightQueue<T> => {
  const inFlight = new Set<string>();
  const pending = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (key: string) => {
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
        void run(value)
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
    trigger: (key: string, value: T) => {
      pending.set(key, value);
      schedule(key);
    }
  };
};
