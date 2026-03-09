import { describe, expect, it, vi } from "vitest";
import { DebouncedRunner } from "./debounced-runner.js";

describe("DebouncedRunner", () => {
  it("coalesces bursts into a single run", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const runner = new DebouncedRunner(200, run);

    runner.trigger();
    runner.trigger();
    runner.trigger();

    await vi.advanceTimersByTimeAsync(199);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    runner.close();
    vi.useRealTimers();
  });

  it("schedules one more run when changes arrive during an active run", async () => {
    vi.useFakeTimers();
    let release = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = new DebouncedRunner(100, run);

    runner.trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    runner.trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);

    runner.close();
    vi.useRealTimers();
  });
});