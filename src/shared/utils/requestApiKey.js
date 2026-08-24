function queryApiKey(request) {
  const nextSearchParams = request?.nextUrl?.searchParams;
  if (typeof nextSearchParams?.get === "function") {
    return nextSearchParams.get("key");
  }

  try {
    return new URL(request?.url).searchParams.get("key");
  } catch {
    return null;
  }
}

/**
 * Extract an endpoint API key using the public API precedence shared by the
 * guard and all downstream request handlers.
 */
export function extractApiKey(request) {
  const authHeader = request?.headers?.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const apiKeyHeader = request?.headers?.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;

  const googleApiKeyHeader = request?.headers?.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;

  return queryApiKey(request);
}
