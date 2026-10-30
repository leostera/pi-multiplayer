/**
 * The session's model: Workers AI, reached through AI Gateway over the Worker's AI binding.
 *
 * Binding calls are authenticated by the binding itself, so there are no API keys to store or
 * rotate: the model runs on the account the Worker is deployed to. Locally (`wrangler dev`) the
 * model is called over the REST API instead, with an API token from `.dev.vars`.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";

export const PROVIDER = "workers-ai";

export interface SessionModels {
  models: MutableModels;
  model: Model<"openai-completions">;
}

export type ModelAccess =
  | { readonly binding: AiBinding; readonly gateway: string }
  | { readonly apiToken: string; readonly accountId: string };

export function workersAiModels(access: ModelAccess, modelId: string): SessionModels {
  const catalog: Readonly<Record<string, Model<Api>>> = CLOUDFLARE_WORKERS_AI_MODELS;
  const known = Object.hasOwn(catalog, modelId) ? catalog[modelId] : undefined;
  if (known?.api !== "openai-completions") throw new Error(`not a Workers AI chat model: ${modelId}`);
  const api = openAICompletionsApi();
  const models = createModels();
  if ("binding" in access) {
    const model = {
      ...(known as Model<"openai-completions">),
      provider: PROVIDER,
      baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${access.gateway}/workers-ai/v1`,
    };
    const fetch = gatewayFetch(createAiBindingFetch(access.binding));
    models.setProvider(
      createProvider({
        id: PROVIDER,
        name: "Workers AI",
        // The gateway ignores this on binding calls; it satisfies the API's "has auth" check, and
        // the null keeps the SDK's placeholder key from reaching the gateway as a provider key.
        headers: { "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`, Authorization: null },
        auth: { apiKey: { name: "AI binding", resolve: async () => ({ auth: { apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL } }) } },
        models: [model],
        api: {
          stream: (m, context, options) => api.stream(m, context, { ...options, fetch }),
          streamSimple: (m, context, options) => api.streamSimple(m, context, { ...options, fetch }),
        },
      }),
    );
    return { models, model };
  }
  const model = {
    ...(known as Model<"openai-completions">),
    provider: PROVIDER,
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${access.accountId}/ai/v1`,
  };
  models.setProvider(
    createProvider({
      id: PROVIDER,
      name: "Workers AI",
      auth: { apiKey: { name: "API token", resolve: async () => ({ auth: { apiKey: access.apiToken } }) } },
      models: [model],
      api,
    }),
  );
  return { models, model };
}

/**
 * Requests over the binding authenticate as the binding. The API's own `Authorization` (its
 * placeholder key) must not reach the gateway, which would take it for a provider key that
 * overrides its stored ones; Workers AI then answers 401. Provider-level header nulls do not
 * remove it, so it is removed here, on every request.
 */
function gatewayFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("cf-aig-authorization", `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`);
    return fetch(input, { ...init, headers });
  };
}
