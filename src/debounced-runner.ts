export class DebouncedRunner {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private running = false;
  private closed = false;
  private activeRun: Promise<void> | null = null;

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

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.activeRun;
  }

  private async flush(): Promise<void> {
    if (this.closed || this.running || !this.dirty) {
      return;
    }
    this.dirty = false;
    this.timer = null;
    this.running = true;
    const activeRun = this.run();
    this.activeRun = activeRun;
    try {
      await activeRun;
    } finally {
      if (this.activeRun === activeRun) {
        this.activeRun = null;
      }
      this.running = false;
      if (this.dirty && !this.closed) {
        this.timer = setTimeout(() => {
          void this.flush();
        }, this.debounceMs);
      }
    }
  }
}
