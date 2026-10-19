import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMidenStore } from "../../store/MidenStore";
import { useCacheGenerationState } from "../../store/useCacheGenerationState";

beforeEach(() => {
  useMidenStore.getState().reset();
});

describe("useCacheGenerationState", () => {
  // A hook that sets an unchanged value on every read (as refetch clears its error) would
  // otherwise re-render, rebuild an inline option and read again, without end.
  it("does not re-render when the value and generation are unchanged", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCacheGenerationState<string | null>(null);
    });
    const { cacheGeneration } = useMidenStore.getState();

    const mounted = renders;
    act(() => result.current[1](null, cacheGeneration));
    expect(renders).toBe(mounted);
    expect(result.current[0]).toBeNull();
  });

  it("shows a value set under the current generation and hides it after a reset", () => {
    const { result } = renderHook(() =>
      useCacheGenerationState<string | null>(null)
    );
    act(() =>
      result.current[1]("loaded", useMidenStore.getState().cacheGeneration)
    );
    expect(result.current[0]).toBe("loaded");

    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(result.current[0]).toBeNull();
  });
});
