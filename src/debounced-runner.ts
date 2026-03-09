export class DebouncedRunner {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private running = false;
  private closed = false;

  constructor(
    private readonly debounceMs: number,
    private readonly run: () => Promise<void>,
  ) {}

  trigger() {
    if (this.closed) {
      return;
    }
    this.dirty = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  close() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async flush(): Promise<void> {
    if (this.closed || this.running || !this.dirty) {
      return;
    }
    this.dirty = false;
    this.timer = null;
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
      if (this.dirty && !this.closed) {
        this.timer = setTimeout(() => {
          void this.flush();
        }, this.debounceMs);
      }
    }
  }
}