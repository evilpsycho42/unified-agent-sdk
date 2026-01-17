/**
 * Single-consumer AsyncIterable event stream with a bounded buffer.
 *
 * Notes:
 * - `events` is intended to be consumed once; repeated consumption throws.
 * - If the consumer is slow, the buffer drops oldest events when full.
 */
export class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly maxBuffer: number;
  private readonly buffer: T[] = [];
  private readonly pending: Array<(result: IteratorResult<T, void>) => void> = [];
  private closed = false;
  private iteratorCreated = false;

  constructor(opts?: { maxBuffer?: number }) {
    this.maxBuffer = opts?.maxBuffer ?? 2048;
  }

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.pending.shift();
    if (resolve) {
      resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.pending.length) {
      const resolve = this.pending.shift();
      if (resolve) resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void, void> {
    if (this.iteratorCreated) {
      throw new Error("RunHandle.events can only be consumed once.");
    }
    this.iteratorCreated = true;

    return {
      next: async () => {
        if (this.buffer.length) return { value: this.buffer.shift() as T, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T, void>>((resolve) => this.pending.push(resolve));
      },
      return: async () => {
        this.buffer.length = 0;
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

