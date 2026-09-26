import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	LlamaClient,
	type LlamaModelInfo,
	type LlamaServerProps,
	llamaInferenceUrl,
	normalizeLlamaServerUrl,
} from "./client.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";

function modelIsSelectable(model: LlamaModelInfo): boolean {
    return model.status.value === "loaded" || model.status.value === "sleeping";
}

function toPiModel(model: LlamaModelInfo, serverUrl: string, props?: LlamaServerProps): Model<"openai-completions"> {
    const reportedContextWindow = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
    const contextWindow = reportedContextWindow && reportedContextWindow > 0 ? reportedContextWindow : 128000;
    const reasoning = props?.chat_template?.includes("enable_thinking") === true;
    
    return {
        id: model.id,
        name: model.id,
        api: "openai-completions",
        provider: LLAMA_PROVIDER_ID,
        baseUrl: llamaInferenceUrl(serverUrl),
        reasoning,
        ...(reasoning && {
            thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null },
        }),
        input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: contextWindow,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
            ...(reasoning && { thinkingFormat: "qwen-chat-template" }),
        },
    };
}

export interface LlamaProviderController {
    provider: Provider<"openai-completions">;
    setCatalog(models: readonly LlamaModelInfo[], serverUrl: string): void;
}

export function createLlamaProvider(serverUrl = DEFAULT_LLAMA_SERVER_URL): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];

	const setCatalog = (catalog: readonly LlamaModelInfo[], url: string): void => {
        models = catalog
            .filter((model) => modelIsSelectable(model))
            .map((model) => toPiModel(model, url));
    };

	const provider: Provider<"openai-completions"> = {
        id: LLAMA_PROVIDER_ID,
        name: "llama.cpp",
        baseUrl: llamaInferenceUrl(serverUrl),
        auth: {
            apiKey: {
                name: "llama.cpp server",
                resolve: async () => ({
                    auth: { apiKey: "local", baseUrl: llamaInferenceUrl(serverUrl) },
                    source: "browser-local",
                }),
            },
        },
        getModels: () => models,
        refreshModels: async (context: RefreshModelsContext): Promise<void> => {
            if (context.stored) {
                const restored = context.stored.models.filter(
                    (model): model is Model<"openai-completions"> =>
                        model.provider === LLAMA_PROVIDER_ID && model.api === "openai-completions",
                );
                if (!(await context.publish({ update: () => { models = restored; } }))) return;
            }

            if (!context.allowNetwork || context.signal.aborted) return;
            
            try {
                const client = new LlamaClient(serverUrl);
                const catalog = await client.list({ signal: context.signal });
                if (context.signal.aborted) return;

                const refreshed = await Promise.all(
                    catalog
                        .filter((model) => modelIsSelectable(model))
                        .map(async (model) => {
                            if (model.status.value !== "loaded") return toPiModel(model, serverUrl);
                            const props = await client.props({ model: model.id, signal: context.signal });
                            return toPiModel(model, serverUrl, props);
                        }),
                );
                
                if (context.signal.aborted) return;
                
                await context.publish({
                    persist: { models: refreshed, checkedAt: Date.now() },
                    update: () => { models = refreshed; },
                });
            } catch (e) {
                console.warn("Llama Provider Refresh Error:", e);
            }
        },
        api: openAICompletionsApi(),
    };

    return { provider, setCatalog };
}
