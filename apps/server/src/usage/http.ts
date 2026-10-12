import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as EnvironmentUsageLimits from "./EnvironmentUsageLimits.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "usage",
  Effect.fnUntraced(function* (handlers) {
    const usage = yield* EnvironmentUsageLimits.EnvironmentUsageLimits;
    return handlers.handle(
      "limits",
      Effect.fn("environment.usage.limits")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* usage.snapshot;
      }),
    );
  }),
);
