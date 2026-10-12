import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { codexbarAccounts, codexbarWindows, makeCodexbarApi } from "./codexbarApi.ts";

const config = {
  kind: "codexbar",
  url: "http://127.0.0.1:8080",
  managementKey: "dashboard-token",
  enabled: true,
} as const;

const snapshot = {
  schemaVersion: 1,
  generatedAt: "2026-10-12T06:00:00Z",
  providers: [
    {
      id: "claude",
      enabled: true,
      identity: { accountEmail: "me@example.com", plan: "Max" },
      windows: [
        { kind: "session", label: "Session", usedPercent: 20, resetAt: "2026-10-12T08:00:00Z" },
        { kind: "weekly", label: "Weekly", usedPercent: 61.5, resetAt: "2026-10-15T00:00:00Z" },
      ],
      updatedAt: "2026-10-12T05:59:00Z",
    },
    {
      id: "codex",
      enabled: true,
      windows: [{ kind: "session", usedPercent: 10 }],
      accounts: [
        {
          id: "codex-managed:a",
          identity: { accountEmail: "work@example.com", plan: "Pro" },
          windows: [{ kind: "weekly", label: "Weekly", usedPercent: 140 }],
          error: null,
          updatedAt: null,
        },
        { id: "codex-managed:b", windows: [], error: "Token expired.", updatedAt: null },
      ],
    },
    { id: "openrouter", enabled: false, windows: [{ kind: "session", usedPercent: 5 }] },
    { id: "zai", enabled: true, windows: [], error: { message: "Rate limited" } },
    { id: "cursor", enabled: true, windows: [] },
  ],
};

describe("codexbarAccounts", () => {
  it("maps enabled rows, prefers listed accounts, and keeps failures visible", () => {
    const accounts = codexbarAccounts(snapshot);
    expect(accounts.map((account) => [account.id, account.driver])).toEqual([
      ["claude", "claudeAgent"],
      ["codex:codex-managed:a", "codex"],
      ["codex:codex-managed:b", "codex"],
      ["zai", "zai"],
    ]);
    expect(accounts[0]).toMatchObject({
      email: "me@example.com",
      plan: "Max",
      usageLimits: {
        checkedAt: "2026-10-12T05:59:00.000Z",
        windows: [
          { id: "session", kind: "session", usedPercent: 20, resetsAt: "2026-10-12T08:00:00.000Z" },
          { id: "weekly", kind: "weekly", usedPercent: 61.5 },
        ],
      },
    });
    expect(accounts[1]?.usageLimits.windows[0]?.usedPercent).toBe(100);
    expect(accounts[2]?.usageLimits.unavailable).toEqual({
      reason: "probeFailed",
      message: "Token expired.",
    });
    expect(accounts[3]?.usageLimits.unavailable?.message).toBe("Rate limited");
  });

  it("skips idle rows and gives repeated kinds stable ids", () => {
    expect(
      codexbarWindows([
        { kind: "antigravity-bucket", label: "Gemini", usedPercent: 3 },
        { kind: "antigravity-bucket", label: "Claude", usedPercent: 50 },
        { kind: "antigravity-bucket", label: "GPT", usedPercent: 0, idle: true },
      ]).map((window) => [window.id, window.kind, window.label]),
    ).toEqual([
      ["antigravity-bucket", "other", "Gemini"],
      ["antigravity-bucket-2", "other", "Claude"],
    ]);
  });
});

describe("makeCodexbarApi", () => {
  const run = (respond: (url: string) => Response, check?: (headers: unknown) => void) =>
    makeCodexbarApi.pipe(
      Effect.flatMap((api) => api.readAccounts(config)),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            check?.(request.headers);
            return HttpClientResponse.fromWeb(request, respond(request.url));
          }),
        ),
      ),
    );

  it.effect("reads the dashboard snapshot with the bearer token", () =>
    Effect.gen(function* () {
      let url = "";
      const accounts = yield* run(
        (requestUrl) => {
          url = requestUrl;
          return Response.json(snapshot);
        },
        (headers) =>
          expect((headers as Record<string, string>).authorization).toBe("Bearer dashboard-token"),
      );
      expect(url).toBe("http://127.0.0.1:8080/dashboard/v1/snapshot");
      expect(accounts).toHaveLength(4);
    }),
  );

  it.effect("reports an unauthorized dashboard and an unknown schema as source errors", () =>
    Effect.gen(function* () {
      const unauthorized = yield* run(() => new Response("{}", { status: 401 })).pipe(Effect.flip);
      expect(unauthorized.detail).toBe("The CodexBar dashboard request failed.");
      const future = yield* run(() => Response.json({ ...snapshot, schemaVersion: 2 })).pipe(
        Effect.flip,
      );
      expect(future.detail).toBe("CodexBar snapshot schema 2 is not supported.");
    }),
  );
});
