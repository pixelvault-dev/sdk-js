import { PixelVaultError } from "./errors.js";
import { request, type HttpConfig } from "./http.js";
import type { components, operations } from "./generated/schema.js";

export type Image = components["schemas"]["Image"];

type Ok<Op extends keyof operations, Code extends number> = operations[Op] extends {
  responses: Record<Code, { content: { "application/json": infer R } }>;
}
  ? R
  : never;

export type Usage = NonNullable<Ok<"get_usage", 200>["data"]>;
export type ApiKey = NonNullable<Ok<"list_keys", 200>["data"]>[number];
export type CreatedKey = NonNullable<Ok<"create_key", 201>["data"]>;
export type SignedUrl = NonNullable<Ok<"sign_image_url", 200>["data"]>;
export type ListMeta = NonNullable<Ok<"list_images", 200>["meta"]>;
export type DeviceLoginResult = NonNullable<Ok<"device_login_complete", 200>["data"]>;
export type RegisteredAccount = NonNullable<Ok<"register_account", 201>["data"]>;
export type BatchResult = NonNullable<Ok<"batch_upload", 201>["data"]>;
/** The image plus `generation`: the model used and the credits charged and left. */
export type GeneratedImage = NonNullable<Ok<"generate_image", 201>["data"]>;

/** Bytes to upload. `Blob`/`File` keep their own name and type. */
export type FileInput = Blob | ArrayBuffer | Uint8Array;

export interface UploadOptions {
  /** Optional folder name. */
  folder?: string;
  /** `private` (secret key only) returns a signed URL. Default `public`. */
  visibility?: "public" | "private";
  /** Signature lifetime in seconds for a private upload (60–2592000). */
  signExpiresIn?: number;
  /** Auto-delete after this many seconds (60–2592000). Omit for permanent. */
  expiresIn?: number;
  signal?: AbortSignal;
}

export interface UploadFileInput extends UploadOptions {
  file: FileInput;
  /** Filename sent with the upload. Defaults to the Blob's name, else `upload`. */
  filename?: string;
  /** MIME type for raw bytes. Ignored when `file` is a Blob that has one. */
  contentType?: string;
}

export interface UploadUrlInput extends UploadOptions {
  /** https URL of an image to import. Requires an API key. */
  url: string;
}

/** Models for `images.generate`. Other ids are passed through, so new models work without an SDK release. */
export type GenerationModel =
  | "flux-1-schnell"
  | "sdxl-lightning"
  | "sdxl-base"
  | "lucid-origin"
  | "phoenix-1.0"
  | (string & {});

export interface GenerateInput {
  /** What to draw (1–2000 characters). */
  prompt: string;
  /**
   * Default `flux-1-schnell` (1 credit). `sdxl-lightning` and `sdxl-base` cost 1,
   * `lucid-origin` and `phoenix-1.0` (Leonardo) cost 20. The free plan can only use the default.
   */
  model?: GenerationModel;
  /** Optional folder name. */
  folder?: string;
  /** `private` (secret key only) returns a signed URL. Default `public`. */
  visibility?: "public" | "private";
  /** Signature lifetime in seconds for a private image (60–2592000). */
  signExpiresIn?: number;
  /** Auto-delete after this many seconds (60–2592000). Omit to keep it. */
  expiresIn?: number;
  signal?: AbortSignal;
}

export interface BatchUploadInput {
  collection: {
    type: string;
    name?: string;
    visibility?: "public" | "private";
    expiresIn?: number;
    signExpiresIn?: number;
    metadata?: Record<string, unknown>;
  };
  images: Array<{
    /** Base64-encoded image bytes. */
    data?: string;
    /** Public URL to import instead of `data`. */
    sourceUrl?: string;
    filename?: string;
    metadata?: Record<string, unknown>;
  }>;
  signal?: AbortSignal;
}

export interface ClientOptions {
  /** API key. Falls back to the `PIXELVAULT_API_KEY` environment variable. */
  apiKey?: string;
  /** Override the API origin. Default `https://api.pixelvault.dev`. */
  baseUrl?: string;
  /** Custom fetch (tests, proxies, older runtimes). Default global `fetch`. */
  fetch?: typeof fetch;
  /** Retries for 429 and, on GET/DELETE, 5xx or network errors. Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
}

function envKey(): string | undefined {
  return typeof process !== "undefined" ? process.env?.["PIXELVAULT_API_KEY"] : undefined;
}

function toBlob(input: UploadFileInput): { blob: Blob; filename: string } {
  const { file } = input;
  if (file instanceof Blob) {
    const named = (file as File).name;
    return { blob: file, filename: input.filename ?? (named || "upload") };
  }
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  const blob = new Blob([bytes as BlobPart], {
    type: input.contentType ?? "application/octet-stream",
  });
  return { blob, filename: input.filename ?? "upload" };
}

export class PixelVault {
  private readonly cfg: HttpConfig;

  readonly images: ImagesResource;
  readonly usage: UsageResource;
  readonly keys: KeysResource;

  constructor(options: ClientOptions = {}) {
    this.cfg = {
      baseUrl: (options.baseUrl ?? "https://api.pixelvault.dev").replace(/\/+$/, ""),
      apiKey: options.apiKey ?? envKey(),
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 60_000,
    };
    this.images = new ImagesResource(this.cfg);
    this.usage = new UsageResource(this.cfg);
    this.keys = new KeysResource(this.cfg);
  }

  /**
   * Create an account. Returns a first live API key once; store it, it is not
   * shown again. Needs no API key.
   */
  async register(input: { email: string; password?: string; signal?: AbortSignal }): Promise<RegisteredAccount> {
    const res = await request<{ data: RegisteredAccount }>(this.cfg, {
      method: "POST",
      path: "/v1/auth/register",
      json: { email: input.email, password: input.password },
      noAuth: true,
      signal: input.signal,
    });
    return res.data;
  }

  /** Step 1 of device login: email a one-time code. Needs no API key. */
  async deviceLoginStart(input: { email: string; signal?: AbortSignal }): Promise<void> {
    await request(this.cfg, {
      method: "POST",
      path: "/v1/auth/device/start",
      json: { email: input.email },
      noAuth: true,
      signal: input.signal,
    });
  }

  /** Step 2 of device login: trade the emailed code for an API key (shown once). */
  async deviceLoginComplete(input: {
    email: string;
    code: string;
    label?: string;
    replaceExisting?: boolean;
    signal?: AbortSignal;
  }): Promise<DeviceLoginResult> {
    const res = await request<{ data: DeviceLoginResult }>(this.cfg, {
      method: "POST",
      path: "/v1/auth/device/complete",
      json: {
        email: input.email,
        code: input.code,
        label: input.label,
        replace_existing: input.replaceExisting,
      },
      noAuth: true,
      signal: input.signal,
    });
    return res.data;
  }
}

class ImagesResource {
  constructor(private readonly cfg: HttpConfig) {}

  /**
   * Upload bytes (`file`) or import a remote image (`url`). Without an API key
   * the upload is anonymous and expires after 30 days.
   */
  async upload(input: UploadFileInput | UploadUrlInput): Promise<Image> {
    if ("url" in input) {
      const res = await request<{ data: Image }>(this.cfg, {
        method: "POST",
        path: "/v1/images",
        json: {
          url: input.url,
          folder: input.folder,
          visibility: input.visibility,
          sign_expires_in: input.signExpiresIn,
          expires_in: input.expiresIn,
        },
        signal: input.signal,
      });
      return res.data;
    }

    const { blob, filename } = toBlob(input);
    const form = new FormData();
    form.set("file", blob, filename);
    if (input.folder) form.set("folder", input.folder);
    if (input.visibility) form.set("visibility", input.visibility);
    if (input.signExpiresIn !== undefined) form.set("sign_expires_in", String(input.signExpiresIn));
    if (input.expiresIn !== undefined) form.set("expires_in", String(input.expiresIn));

    const res = await request<{ data: Image }>(this.cfg, {
      method: "POST",
      path: "/v1/images",
      form,
      signal: input.signal,
    });
    return res.data;
  }

  /**
   * Generate an image from a prompt and host it in one call. Spends credits from the
   * account's monthly grant (free 10, Starter 300, Pro 1,500; they reset on the 1st, UTC).
   * The result is a normal image plus `generation: { model, credits_charged, credits_remaining }`
   * with the field names exactly as the API returns them. A failed generation is refunded. Needs a
   * secret key and a verified email. Never retried after a 5xx or a network error, so a
   * lost response cannot spend credits twice. A call can take several seconds; raise
   * `timeoutMs` on the client if you use the slower models.
   */
  async generate(input: GenerateInput): Promise<GeneratedImage> {
    const res = await request<{ data: GeneratedImage }>(this.cfg, {
      method: "POST",
      path: "/v1/images/generate",
      json: {
        prompt: input.prompt,
        model: input.model,
        folder: input.folder,
        visibility: input.visibility,
        sign_expires_in: input.signExpiresIn,
        expires_in: input.expiresIn,
      },
      signal: input.signal,
    });
    return res.data;
  }

  /** Upload up to 50 images into one collection (CI screenshots and similar). */
  async uploadBatch(input: BatchUploadInput): Promise<BatchResult> {
    const c = input.collection;
    const res = await request<{ data: BatchResult }>(this.cfg, {
      method: "POST",
      path: "/v1/images/batch",
      json: {
        collection: {
          type: c.type,
          name: c.name,
          visibility: c.visibility,
          expires_in: c.expiresIn,
          sign_expires_in: c.signExpiresIn,
          metadata: c.metadata,
        },
        images: input.images.map((i) => ({
          data: i.data,
          source_url: i.sourceUrl,
          filename: i.filename,
          metadata: i.metadata,
        })),
      },
      signal: input.signal,
    });
    return res.data;
  }

  /** One page of images, newest first. */
  async list(params: { page?: number; perPage?: number; signal?: AbortSignal } = {}): Promise<{
    data: Image[];
    meta: ListMeta;
  }> {
    const res = await request<{ data?: Image[]; meta?: ListMeta }>(this.cfg, {
      method: "GET",
      path: "/v1/images",
      query: { page: params.page, per_page: params.perPage },
      signal: params.signal,
    });
    return {
      data: res.data ?? [],
      meta: res.meta ?? { total: 0, page: params.page ?? 1, per_page: params.perPage ?? 0 },
    };
  }

  /** Iterate every image across pages: `for await (const img of pv.images.listAll())`. */
  async *listAll(params: { perPage?: number; signal?: AbortSignal } = {}): AsyncGenerator<Image> {
    for (let page = 1; ; page++) {
      const { data, meta } = await this.list({ page, perPage: params.perPage, signal: params.signal });
      yield* data;
      const perPage = meta.per_page ?? data.length;
      if (data.length === 0 || page * perPage >= (meta.total ?? 0)) return;
    }
  }

  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<Image> {
    const res = await request<{ data: Image }>(this.cfg, {
      method: "GET",
      path: `/v1/images/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
    return res.data;
  }

  async delete(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/images/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }

  /** Signed URL for a private image. `expiresIn` is 60–2592000 seconds (default 3600). */
  async signUrl(id: string, opts: { expiresIn?: number; signal?: AbortSignal } = {}): Promise<SignedUrl> {
    const res = await request<{ data: SignedUrl }>(this.cfg, {
      method: "POST",
      path: `/v1/images/${encodeURIComponent(id)}/sign-url`,
      json: opts.expiresIn !== undefined ? { expires_in: opts.expiresIn } : {},
      signal: opts.signal,
    });
    return res.data;
  }
}

class UsageResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** Plan, usage, limits and what is left this month. */
  async get(opts: { signal?: AbortSignal } = {}): Promise<Usage> {
    const res = await request<{ data: Usage }>(this.cfg, {
      method: "GET",
      path: "/v1/usage",
      signal: opts.signal,
    });
    return res.data;
  }
}

class KeysResource {
  constructor(private readonly cfg: HttpConfig) {}

  async list(opts: { signal?: AbortSignal } = {}): Promise<ApiKey[]> {
    const res = await request<{ data: ApiKey[] }>(this.cfg, {
      method: "GET",
      path: "/v1/keys",
      signal: opts.signal,
    });
    return res.data;
  }

  /** Mint a secret key. The raw key is in the response once and never again. */
  async create(
    input: { label?: string; environment?: "live" | "test"; signal?: AbortSignal } = {}
  ): Promise<CreatedKey> {
    const res = await request<{ data: CreatedKey }>(this.cfg, {
      method: "POST",
      path: "/v1/keys",
      json: { label: input.label, environment: input.environment },
      signal: input.signal,
    });
    return res.data;
  }

  /** Revoke a key. The key making the request cannot revoke itself. */
  async revoke(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/keys/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }
}

export { PixelVaultError };
