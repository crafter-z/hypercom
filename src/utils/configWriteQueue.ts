let lastConfigWrite: Promise<unknown> = Promise.resolve();

/** Serialize every full-config write in this webview, including editor CRUD. */
export function enqueueConfigWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = lastConfigWrite.then(work);
  lastConfigWrite = result.then(() => undefined, () => undefined);
  return result;
}
