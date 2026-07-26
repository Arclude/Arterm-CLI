import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, sleep } from "./retry.js";

/** A sleep that never actually waits but records the requested delays. */
function instantSleep(delays: number[]) {
  return async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    delays.push(ms);
  };
}

function jsonResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

describe("fetchWithRetry", () => {
  it("returns an ok response without retrying", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return jsonResponse(200);
        },
        sleep: instantSleep([]),
      },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries 429/5xx and succeeds", async () => {
    const statuses = [429, 503, 200];
    let calls = 0;
    const delays: number[] = [];
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => jsonResponse(statuses[calls++] as number),
        sleep: instantSleep(delays),
      },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("does not retry non-retryable statuses (e.g. 401)", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return jsonResponse(401);
        },
        sleep: instantSleep([]),
      },
    );
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("returns the last failing response once retries are exhausted", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        retries: 2,
        fetchImpl: async () => {
          calls++;
          return jsonResponse(503);
        },
        sleep: instantSleep([]),
      },
    );
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("retries network errors and throws the last one when exhausted", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(
        "http://x/",
        {},
        {
          retries: 1,
          fetchImpl: async () => {
            calls++;
            throw new TypeError("fetch failed");
          },
          sleep: instantSleep([]),
        },
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(2);
  });

  it("never retries an abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      fetchWithRetry(
        "http://x/",
        { signal: controller.signal },
        {
          signal: controller.signal,
          fetchImpl: async () => {
            calls++;
            controller.abort();
            throw new DOMException("aborted", "AbortError");
          },
          sleep: instantSleep([]),
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("honors a numeric Retry-After header", async () => {
    const delays: number[] = [];
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? jsonResponse(429, { "retry-after": "2" }) : jsonResponse(200);
        },
        sleep: instantSleep(delays),
      },
    );
    expect(res.status).toBe(200);
    expect(delays).toEqual([2000]);
  });

  it("waits a Retry-After that sits exactly on the budget", async () => {
    const delays: number[] = [];
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? jsonResponse(429, { "retry-after": "30" }) : jsonResponse(200);
        },
        sleep: instantSleep(delays),
      },
    );
    expect(res.status).toBe(200);
    expect(delays).toEqual([30_000]);
  });

  it("gives up immediately when Retry-After exceeds the wait budget", async () => {
    // A one-hour rate limit does not clear because we waited 30s three times.
    // Returning now is what lets the fallback chain reach a model that answers.
    const delays: number[] = [];
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return jsonResponse(429, { "retry-after": "3600" });
        },
        sleep: instantSleep(delays),
      },
    );
    expect(res.status).toBe(429);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("leaves the short-circuited body unread for the caller's error detail", async () => {
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () =>
          new Response('{"error":"monthly quota exhausted"}', {
            status: 429,
            headers: { "retry-after": "7200" },
          }),
        sleep: instantSleep([]),
      },
    );
    expect(res.bodyUsed).toBe(false);
    await expect(res.text()).resolves.toContain("monthly quota exhausted");
  });

  it("honors an HTTP-date Retry-After beyond the budget", async () => {
    const delays: number[] = [];
    let calls = 0;
    const res = await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return jsonResponse(503, {
            "retry-after": new Date(Date.now() + 20 * 60_000).toUTCString(),
          });
        },
        sleep: instantSleep(delays),
      },
    );
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it("still backs off normally when the budget is raised", async () => {
    const delays: number[] = [];
    let calls = 0;
    await fetchWithRetry(
      "http://x/",
      {},
      {
        maxWaitMs: 120_000,
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? jsonResponse(429, { "retry-after": "60" }) : jsonResponse(200);
        },
        sleep: instantSleep(delays),
      },
    );
    expect(delays).toEqual([60_000]);
  });
});

describe("sleep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the event loop alive while a backoff is pending", async () => {
    // Regression: this timer was unref'd "so a backoff can't hold the process
    // open". But during a retry the dead socket holds nothing either, so the
    // timer is the only ref left — `arterm --print` exited 0 mid-backoff with no
    // answer, no error, and no second attempt. Cancellation is `signal`'s job.
    const realSetTimeout = globalThis.setTimeout;
    let unrefCalled = false;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ): ReturnType<typeof setTimeout> => {
      const handle = realSetTimeout(fn, ms);
      const realUnref = handle.unref.bind(handle);
      handle.unref = () => {
        unrefCalled = true;
        return realUnref();
      };
      return handle;
    }) as unknown as typeof setTimeout);

    await sleep(1);
    expect(unrefCalled).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(50_000, controller.signal)).rejects.toBeDefined();
  });

  it("rejects as soon as the signal fires, without waiting out the delay", async () => {
    const controller = new AbortController();
    const pending = sleep(50_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
