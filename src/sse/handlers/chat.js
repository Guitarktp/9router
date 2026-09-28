import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import {
  resolveApiKeyRoutingContext,
  isProviderActive,
  getAllowedConnectionIds,
  filterModelCandidates,
} from "../services/apiKeyRouting.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  const settings = await getSettings();
  const routingContext = await resolveApiKeyRoutingContext({
    apiKey,
    requireApiKey: !!settings.requireApiKey,
  });
  if (!routingContext.ok) {
    log.warn("AUTH", routingContext.message);
    return errorResponse(routingContext.status, routingContext.message);
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Resolve and authorize the requested direct provider or combo before a
  // synthetic CLI response. This preflight does not consume rotation state or
  // select credentials.
  const comboModels = await getComboModels(modelStr);
  let authorizedComboModels = comboModels;
  let requestedModelInfo = null;
  if (comboModels) {
    authorizedComboModels = await filterModelCandidates(comboModels, routingContext);
    if (authorizedComboModels.length === 0) {
      return emptyComboResponse(routingContext, modelStr);
    }
  } else {
    requestedModelInfo = await getModelInfo(modelStr);
    if (requestedModelInfo.provider && !isProviderActive(routingContext, requestedModelInfo.provider)) {
      return inactiveProviderResponse(routingContext, requestedModelInfo.provider);
    }
  }

  // Bypass naming/warmup requests after policy preflight but before combo
  // rotation and credential selection.
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  if (comboModels) {
    return handleResolvedCombo({
      body,
      comboModels: authorizedComboModels,
      comboName: modelStr,
      clientRawRequest,
      request,
      apiKey,
      routingContext,
      settings,
      requiredCapabilities,
      comboModelsAreAuthorized: true,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = await filterModelCandidates(
    augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings),
    routingContext,
  );
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, routingContext),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, routingContext);
}

function emptyComboResponse(context, comboName) {
  return errorResponse(
    HTTP_STATUS.FORBIDDEN,
    `No providers in combo "${comboName}" are active for API key "${context.key?.name || "selected key"}"`,
    { code: "no_active_combo_providers_for_api_key" },
  );
}

function inactiveProviderResponse(context, provider) {
  return errorResponse(
    HTTP_STATUS.FORBIDDEN,
    `Provider "${provider}" is not active for API key "${context.key?.name || "selected key"}"`,
    { code: "provider_not_active_for_api_key" },
  );
}

async function handleResolvedCombo({
  body,
  comboModels,
  comboName,
  clientRawRequest,
  request,
  apiKey,
  routingContext,
  settings,
  requiredCapabilities,
  comboModelsAreAuthorized = false,
}) {
  const allowedComboModels = comboModelsAreAuthorized
    ? comboModels
    : await filterModelCandidates(comboModels, routingContext);
  if (allowedComboModels.length === 0) {
    return emptyComboResponse(routingContext, comboName);
  }

  const comboStrategies = settings.comboStrategies || {};
  const comboSpecificStrategy = comboStrategies[comboName]?.fallbackStrategy;
  const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
  const augmentedModels = augmentModelsWithCapacityAdapter(
    allowedComboModels,
    requiredCapabilities,
    settings,
  );
  const filteredAugmentedModels = await filterModelCandidates(augmentedModels, routingContext);
  if (filteredAugmentedModels.length === 0) {
    return emptyComboResponse(routingContext, comboName);
  }
  const adapterAdded = filteredAugmentedModels.filter((m) => !allowedComboModels.includes(m));

  if (comboStrategy === "fusion") {
    log.info("CHAT", `Combo "${comboName}" with ${allowedComboModels.length} models (strategy: fusion)`);
    return handleFusionChat({
      body,
      models: allowedComboModels,
      handleSingleModel: (b, m, isPanel) => {
        let cleanRawReq = clientRawRequest;
        if (isPanel && clientRawRequest) {
          const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
          cleanRawReq = { ...clientRawRequest, body: cleanBody };
        }
        return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, routingContext);
      },
      log,
      comboName,
      judgeModel: comboStrategies[comboName]?.judgeModel,
      tuning: comboStrategies[comboName]?.fusionTuning,
    });
  }

  const comboStickyLimit = settings.comboStickyRoundRobinLimit;
  log.info("CHAT", `Combo "${comboName}" with ${filteredAugmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
  return handleComboChat({
    body,
    models: filteredAugmentedModels,
    handleSingleModel: withCapacityAdapterStripping(
      (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, routingContext),
      adapterAdded
    ),
    log,
    comboName,
    comboStrategy,
    comboStickyLimit
  });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, routingContext) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      const requiredCapabilities = detectRequiredCapabilities(body);
      return handleResolvedCombo({
        body,
        comboModels,
        comboName: modelStr,
        clientRawRequest,
        request,
        apiKey,
        routingContext,
        settings: chatSettings,
        requiredCapabilities,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  if (!isProviderActive(routingContext, provider)) {
    return inactiveProviderResponse(routingContext, provider);
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  const allowedConnectionIds = getAllowedConnectionIds(routingContext, provider);
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(
      provider,
      excludeConnectionIds,
      model,
      { allowedConnectionIds },
    );

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(
        lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        lastError || "All accounts unavailable",
        {},
        lastHeaders,
      );
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
