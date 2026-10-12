// The HTTP route and the t3_usage_limits MCP tool both read `snapshot`, so every reader sees the same numbers.
import {
  type EnvironmentUsageLimits as EnvironmentUsageLimitsPayload,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type UsageLimitsActivity,
} from "@t3tools/contracts";
import { collectEnvironmentUsageLimits } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export class EnvironmentUsageLimits extends Context.Service<
  EnvironmentUsageLimits,
  {
    /** Never fails: unreadable thread state degrades to no activity. */
    readonly snapshot: Effect.Effect<EnvironmentUsageLimitsPayload>;
  }
>()("t3/usage/EnvironmentUsageLimits") {}

const RUNNING = new Set(["preparing", "starting", "running", "waiting"]);

type ActivityThread = Pick<
  OrchestrationV2ThreadShell,
  "providerInstanceId" | "status" | "lastErrorClass" | "usageLimitResetAt" | "archivedAt"
>;

/** Threads per provider instance, in the registry's order; idle instances are omitted. */
export function usageLimitsActivity(
  providers: readonly Pick<ServerProvider, "instanceId" | "driver">[],
  threads: readonly ActivityThread[],
  now: number,
): UsageLimitsActivity[] {
  const activity: UsageLimitsActivity[] = [];
  for (const provider of providers) {
    let runningThreads = 0;
    let limitedThreads = 0;
    let nextReset: number | null = null;
    for (const thread of threads) {
      if (thread.providerInstanceId !== provider.instanceId || thread.archivedAt) continue;
      if (RUNNING.has(thread.status)) {
        runningThreads += 1;
        continue;
      }
      if (thread.status !== "failed" || thread.lastErrorClass !== "usage_limit") continue;
      const resetMs = thread.usageLimitResetAt ? Date.parse(thread.usageLimitResetAt) : NaN;
      if (!Number.isFinite(resetMs) || resetMs <= now) continue;
      limitedThreads += 1;
      nextReset = nextReset === null ? resetMs : Math.min(nextReset, resetMs);
    }
    if (runningThreads === 0 && limitedThreads === 0) continue;
    activity.push({
      instanceId: provider.instanceId,
      driver: provider.driver,
      runningThreads,
      limitedThreads,
      ...(nextReset === null
        ? {}
        : { nextLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nextReset)) }),
    });
  }
  return activity;
}

/** @public */
export const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const snapshot = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const providers = yield* providerRegistry.getProviders;
    const report = collectEnvironmentUsageLimits(providers, yield* sources.current, now);
    const threads = yield* projections
      .getShellSnapshot({ location: "active", unsettledOnly: true })
      .pipe(
        Effect.map((shell) => shell.threads),
        Effect.catchCause((cause) =>
          Effect.logWarning("usage limits activity unavailable", { cause }).pipe(Effect.as([])),
        ),
      );
    return {
      schemaVersion: 1 as const,
      ...report,
      activity: usageLimitsActivity(providers, threads, now),
    };
  }).pipe(Effect.withSpan("EnvironmentUsageLimits.snapshot"));

  return { snapshot } satisfies EnvironmentUsageLimits["Service"];
});

export const layer = Layer.effect(EnvironmentUsageLimits, make);
