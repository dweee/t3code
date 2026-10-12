import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { usageLimitsActivity } from "./EnvironmentUsageLimits.ts";

const now = Date.parse("2026-10-12T06:00:00.000Z");
const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
};
const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
};
const thread = (
  overrides: Partial<Parameters<typeof usageLimitsActivity>[1][number]> = {},
): Parameters<typeof usageLimitsActivity>[1][number] => ({
  providerInstanceId: claude.instanceId,
  status: "running",
  lastErrorClass: null,
  usageLimitResetAt: null,
  archivedAt: null,
  ...overrides,
});

describe("usageLimitsActivity", () => {
  it("counts running and limited threads per instance and finds the next reset", () => {
    const limited = (resetAt: string) =>
      thread({ status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: resetAt });
    const activity = usageLimitsActivity(
      [claude, codex],
      [
        thread(),
        thread({ status: "waiting" }),
        thread({ status: "completed" }),
        limited("2026-10-12T09:00:00.000Z"),
        limited("2026-10-12T08:00:00.000Z"),
        // A reset already passed is recovery's business, not a limit.
        limited("2026-10-12T05:00:00.000Z"),
        thread({ status: "failed", lastErrorClass: "provider_error" as never }),
        thread({ archivedAt: "2026-10-11T00:00:00.000Z" as never }),
      ],
      now,
    );
    expect(activity).toEqual([
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        runningThreads: 2,
        limitedThreads: 2,
        nextLimitResetAt: "2026-10-12T08:00:00.000Z",
      },
    ]);
  });
});
