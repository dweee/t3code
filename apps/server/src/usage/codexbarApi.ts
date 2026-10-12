import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Reads a `codexbar serve` dashboard (`/dashboard/v1/snapshot`, schema 1).
 * Every field beyond the windows is optional there, so decoding is lenient:
 * a provider row CodexBar could not fetch keeps its place with the error.
 */
const Window = Schema.Struct({
  kind: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  usedPercent: Schema.optional(Schema.NullOr(Schema.Number)),
  resetAt: Schema.optional(Schema.NullOr(Schema.String)),
  idle: Schema.optional(Schema.Boolean),
});
const Identity = Schema.NullOr(
  Schema.Struct({
    accountEmail: Schema.optional(Schema.NullOr(Schema.String)),
    plan: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const ErrorPayload = Schema.optional(
  Schema.NullOr(
    Schema.Union([Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })]),
  ),
);
const Account = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  identity: Schema.optional(Identity),
  windows: Schema.optional(Schema.Array(Window)),
  error: ErrorPayload,
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const Provider = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  identity: Schema.optional(Identity),
  windows: Schema.optional(Schema.Array(Window)),
  accounts: Schema.optional(Schema.Array(Account)),
  error: ErrorPayload,
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const Snapshot = Schema.Struct({
  schemaVersion: Schema.Number,
  generatedAt: Schema.String,
  providers: Schema.Array(Provider),
});
const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);

/** CodexBar provider ids whose T3 driver has a different name. */
const DRIVER_BY_CODEXBAR_ID: Record<string, string> = { claude: "claudeAgent" };
const SLUG = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function codexbarDriver(providerId: string): ProviderDriverKind | null {
  const driver = DRIVER_BY_CODEXBAR_ID[providerId] ?? providerId;
  return SLUG.test(driver) ? ProviderDriverKind.make(driver) : null;
}

function windowKind(kind: string): ServerProviderUsageWindow["kind"] {
  if (kind === "session" || kind === "weekly" || kind === "monthly") return kind;
  return "other";
}

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? DateTime.formatIso(DateTime.makeUnsafe(ms)) : undefined;
}

/** Ids stay stable per kind so a refresh lands on the same row. */
export function codexbarWindows(
  windows: ReadonlyArray<typeof Window.Type>,
): ServerProviderUsageWindow[] {
  const seen = new Map<string, number>();
  const result: ServerProviderUsageWindow[] = [];
  for (const window of windows) {
    if (window.idle === true || typeof window.usedPercent !== "number") continue;
    if (!Number.isFinite(window.usedPercent)) continue;
    const kind = window.kind.trim() || "other";
    const count = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, count);
    const resetsAt = isoOrUndefined(window.resetAt);
    result.push({
      id: count === 1 ? kind : `${kind}-${count}`,
      kind: windowKind(kind),
      label: window.label?.trim() || kind,
      usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return result;
}

function errorMessage(error: typeof ErrorPayload.Type): string | undefined {
  if (!error) return undefined;
  const text = typeof error === "string" ? error : error.message;
  return text?.trim() || undefined;
}

function toAccount(
  id: string,
  driver: ProviderDriverKind,
  row: {
    readonly identity?: typeof Identity.Type | undefined;
    readonly windows?: ReadonlyArray<typeof Window.Type> | undefined;
    readonly error?: typeof ErrorPayload.Type;
    readonly updatedAt?: string | null | undefined;
  },
  generatedAt: string,
): UsageLimitSourceAccount {
  const checkedAt = isoOrUndefined(row.updatedAt) ?? generatedAt;
  const windows = codexbarWindows(row.windows ?? []);
  const message = errorMessage(row.error);
  const email = row.identity?.accountEmail?.trim();
  const plan = row.identity?.plan?.trim();
  return {
    id,
    driver,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    usageLimits:
      windows.length === 0 && message
        ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message })
        : { checkedAt, windows },
  };
}

/** One account per enabled provider row, or per account when CodexBar lists several. */
export function codexbarAccounts(
  snapshot: typeof Snapshot.Type,
): ReadonlyArray<UsageLimitSourceAccount> {
  const generatedAt =
    isoOrUndefined(snapshot.generatedAt) ?? DateTime.formatIso(DateTime.makeUnsafe(0));
  return snapshot.providers.flatMap((provider) => {
    const driver = codexbarDriver(provider.id);
    if (provider.enabled === false || driver === null) return [];
    if (provider.accounts && provider.accounts.length > 0) {
      return provider.accounts.map((account) =>
        toAccount(`${provider.id}:${account.id}`, driver, account, generatedAt),
      );
    }
    const account = toAccount(provider.id, driver, provider, generatedAt);
    return account.usageLimits.windows.length > 0 || account.usageLimits.unavailable
      ? [account]
      : [];
  });
}

export const makeCodexbarApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readAccounts = Effect.fn("CodexbarApi.readAccounts")(function* (
    config: UsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const url = yield* Effect.try({
      try: () => new URL("/dashboard/v1/snapshot", config.url).toString(),
      catch: () => new UsageLimitSourceError({ detail: "The CodexBar URL is not valid." }),
    });
    const request = HttpClientRequest.get(url).pipe(
      config.managementKey.length > 0
        ? HttpClientRequest.setHeader("Authorization", `Bearer ${config.managementKey}`)
        : (request) => request,
    );
    const body = yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("30 seconds"),
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "The CodexBar dashboard request failed." }),
      ),
    );
    const snapshot = yield* decodeSnapshot(body).pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "CodexBar returned an unknown snapshot." }),
      ),
    );
    if (snapshot.schemaVersion !== 1) {
      return yield* new UsageLimitSourceError({
        detail: `CodexBar snapshot schema ${snapshot.schemaVersion} is not supported.`,
      });
    }
    return codexbarAccounts(snapshot);
  });

  return { readAccounts };
});
