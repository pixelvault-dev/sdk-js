import { PixelVaultError } from "./errors.js";

export const VERSION = "0.1.0";

export interface HttpConfig {
  baseUrl: string;
  apiKey?: string;
  fetch: typeof fetch;
  maxRetries: number;
  timeoutMs: number;
  userAgentSuffix?: string;
}

export interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  /** Skip the Authorization header (register, device login). */
  noAuth?: boolean;
  /** Per-call abort signal. */
  signal?: AbortSignal;
}

const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * 429 is always safe to retry (the request was rejected before running).
 * 5xx and network errors are only retried for idempotent methods, so a
 * dropped upload response can never create a duplicate image.
 */
function retryable(method: string, status: number): boolean {
  if (status === 429) return true;
  return (method === "GET" || method === "DELETE") && status >= 500;
}

export async function request<T>(
  cfg: HttpConfig,
  opts: RequestOptions
): Promise<T> {
  const url = new URL(cfg.baseUrl + opts.path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-PixelVault-Client": `sdk-js/${VERSION}`,
  };
  if (cfg.apiKey && !opts.noAuth) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await cfg.fetch(url, { method: opts.method, headers, body, signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const canRetry =
        attempt < cfg.maxRetries &&
        (opts.method === "GET" || opts.method === "DELETE");
      if (canRetry) {
        await sleep(Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS), opts.signal);
        continue;
      }
      throw new PixelVaultError(
        `Network error: ${err instanceof Error ? err.message : "request failed"}`,
        0,
        "network_error"
      );
    }

    if (res.ok) {
      return (await res.json()) as T;
    }

    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    if (attempt < cfg.maxRetries && retryable(opts.method, res.status)) {
      const wait = retryAfter !== undefined ? retryAfter * 1000 : 500 * 2 ** attempt;
      // A long Retry-After (e.g. an hourly cap) is not worth blocking on.
      if (wait <= MAX_BACKOFF_MS) {
        await sleep(wait, opts.signal);
        continue;
      }
    }

    let code = "unknown_error";
    let message = `Request failed with status ${res.status}`;
    try {
      const parsed = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body; keep the defaults
    }
    throw new PixelVaultError(message, res.status, code, retryAfter);
  }
}
