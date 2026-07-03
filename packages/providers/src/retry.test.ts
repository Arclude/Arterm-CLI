import { describe, expect, it } from "vitest";
import { fetchWithRetry } from "./retry.js";

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

  it("caps Retry-After at 30s", async () => {
    const delays: number[] = [];
    let calls = 0;
    await fetchWithRetry(
      "http://x/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? jsonResponse(429, { "retry-after": "600" }) : jsonResponse(200);
        },
        sleep: instantSleep(delays),
      },
    );
    expect(delays).toEqual([30_000]);
  });
});
