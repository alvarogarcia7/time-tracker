// Runs tasks one after another: each starts when the one before it has finished, whether it
// succeeded or failed. A task that fails does not stop the queue.
export function serialised(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
