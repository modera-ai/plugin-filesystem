/** Acquire every file lane together; unrelated files can proceed independently. */
export class WriteQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(operation: () => Promise<T>, paths: string[] = ["*"]): Promise<T> {
    const keys = [...new Set(paths)].sort();
    const result = Promise.all(keys.map((key) => this.tails.get(key))).then(
      operation,
    );
    const tail = result.catch(() => {});
    for (const key of keys) this.tails.set(key, tail);
    void tail.then(() => {
      for (const key of keys)
        if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
