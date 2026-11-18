import { request, type HttpConfig } from "./http.js";
import type { components } from "./generated/schema.js";

export type Video = components["schemas"]["Video"] & { branded_url?: string };
export type VideoVisibility = "public" | "private";
export type VideoJob = "enrichment" | "optimization";
export type VideoJobStatus =
  | "not_requested"
  | "not_needed"
  | "pending"
  | "processing"
  | "complete"
  | "failed";

export type VideoFileInput = Blob | ArrayBuffer | Uint8Array;

export interface VideoLifecycleOptions {
  visibility?: VideoVisibility;
  signExpiresIn?: number;
  expiresIn?: number;
  folder?: string;
  collectionId?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoUploadOptions extends VideoLifecycleOptions {
  socialReady?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface UploadVideoFileInput extends VideoUploadOptions {
  file: VideoFileInput;
  filename?: string;
  /** Lowercase hex digest. Required with idempotencyKey; computed when omitted. */
  sha256?: string;
}

export interface ImportVideoInput extends VideoUploadOptions {
  url: string;
  filename?: string;
}

export interface VideoListParams {
  page?: number;
  perPage?: number;
  folder?: string;
  collectionId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface VideoListMeta {
  total: number;
  page: number;
  per_page: number;
}

export interface UpdateVideoInput {
  metadata?: Record<string, unknown> | null;
  folder?: string | null;
  collectionId?: string | null;
  signal?: AbortSignal;
}

export interface CreateVideoUploadInput extends VideoLifecycleOptions {
  filename: string;
  size: number;
  sha256?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface VideoUploadSession {
  upload_id: string;
  asset_id: string;
  part_size: number;
  size: number;
  visibility: VideoVisibility;
  expires_at: string;
  asset_expires_at?: string;
  replayed?: boolean;
  completed?: boolean;
  asset?: Video;
}

export interface VideoUploadedPart {
  part_number: number;
  etag: string;
  received: number;
  replayed?: boolean;
}

export interface UploadResumableVideoInput extends VideoUploadOptions {
  file: VideoFileInput;
  filename?: string;
  sha256?: string;
}

export interface VideoWaitOptions {
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
}

export interface VideoWaitResult {
  video: Video;
  status: VideoJobStatus;
  timedOut: boolean;
}

export interface VideoSignedUrls {
  url: string;
  branded_url?: string;
  poster_url?: string;
  social_url?: string;
  enrichment: Video["enrichment"];
  expires: number;
}

function toBlob(file: VideoFileInput, filename?: string): { blob: Blob; filename: string } {
  if (file instanceof Blob) {
    const named = file as Blob & { name?: string };
    return { blob: file, filename: filename ?? named.name ?? "video.mp4" };
  }
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  return {
    blob: new Blob([bytes as BlobPart], { type: "video/mp4" }),
    filename: filename ?? "video.mp4",
  };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle ?? (await import("node:crypto")).webcrypto.subtle;
  return hex(await subtle.digest("SHA-256", await blob.arrayBuffer()));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function lifecycleJson(input: VideoLifecycleOptions): Record<string, unknown> {
  return {
    visibility: input.visibility,
    sign_expires_in: input.signExpiresIn,
    expires_in: input.expiresIn,
    folder: input.folder,
    collection_id: input.collectionId,
    metadata: input.metadata,
  };
}

export class VideosResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** Upload original MP4 bytes or securely import an HTTPS MP4 URL. */
  async upload(input: UploadVideoFileInput | ImportVideoInput): Promise<Video> {
    if ("url" in input) {
      const response = await request<{ data: Video }>(this.cfg, {
        method: "POST",
        path: "/v1/videos",
        headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
        json: {
          url: input.url,
          filename: input.filename,
          social_ready: input.socialReady,
          ...lifecycleJson(input),
        },
        signal: input.signal,
      });
      return response.data;
    }

    const { blob, filename } = toBlob(input.file, input.filename);
    const digest = input.sha256 ?? (input.idempotencyKey ? await sha256(blob) : undefined);
    const headers: Record<string, string> = {
      "Content-Type": "video/mp4",
      "X-PixelVault-Filename": encodeURIComponent(filename),
    };
    if (input.visibility) headers["X-PixelVault-Visibility"] = input.visibility;
    if (input.signExpiresIn !== undefined) headers["X-PixelVault-Sign-Expires-In"] = String(input.signExpiresIn);
    if (input.socialReady !== undefined) headers["X-PixelVault-Social-Ready"] = String(input.socialReady);
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    if (digest) headers["X-PixelVault-Content-SHA256"] = digest;
    if (input.folder) headers["X-PixelVault-Folder"] = input.folder;
    if (input.collectionId) headers["X-PixelVault-Collection-Id"] = input.collectionId;
    if (input.metadata !== undefined) headers["X-PixelVault-Metadata"] = JSON.stringify(input.metadata);
    if (input.expiresIn !== undefined) headers["X-PixelVault-Expires-In"] = String(input.expiresIn);

    const response = await request<{ data: Video }>(this.cfg, {
      method: "POST",
      path: "/v1/videos",
      headers,
      body: blob,
      signal: input.signal,
    });
    return response.data;
  }

  async createUpload(input: CreateVideoUploadInput): Promise<VideoUploadSession> {
    const response = await request<{ data: VideoUploadSession }>(this.cfg, {
      method: "POST",
      path: "/v1/videos/uploads",
      headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
      json: {
        filename: input.filename,
        size: input.size,
        sha256: input.sha256,
        ...lifecycleJson(input),
      },
      signal: input.signal,
    });
    return response.data;
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    data: VideoFileInput,
    opts: { sha256?: string; signal?: AbortSignal } = {},
  ): Promise<VideoUploadedPart> {
    const { blob } = toBlob(data);
    const response = await request<{ data: VideoUploadedPart }>(this.cfg, {
      method: "PUT",
      path: `/v1/videos/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
      headers: {
        "Content-Type": "application/octet-stream",
        ...(opts.sha256 ? { "X-PixelVault-Part-SHA256": opts.sha256 } : {}),
      },
      body: blob,
      signal: opts.signal,
    });
    return response.data;
  }

  async completeUpload(
    uploadId: string,
    opts: { socialReady?: boolean; signExpiresIn?: number; signal?: AbortSignal } = {},
  ): Promise<Video> {
    const headers: Record<string, string> = {};
    if (opts.socialReady !== undefined) headers["X-PixelVault-Social-Ready"] = String(opts.socialReady);
    if (opts.signExpiresIn !== undefined) headers["X-PixelVault-Sign-Expires-In"] = String(opts.signExpiresIn);
    const response = await request<{ data: Video }>(this.cfg, {
      method: "POST",
      path: `/v1/videos/uploads/${encodeURIComponent(uploadId)}/complete`,
      headers,
      signal: opts.signal,
    });
    return response.data;
  }

  async abortUpload(uploadId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/videos/uploads/${encodeURIComponent(uploadId)}`,
      signal: opts.signal,
    });
  }

  /** Multipart upload with replay-safe initiation, parts, and completion. */
  async uploadResumable(input: UploadResumableVideoInput): Promise<Video> {
    const { blob, filename } = toBlob(input.file, input.filename);
    const digest = input.sha256 ?? await sha256(blob);
    const session = await this.createUpload({
      filename,
      size: blob.size,
      sha256: digest,
      idempotencyKey: input.idempotencyKey,
      visibility: input.visibility,
      expiresIn: input.expiresIn,
      folder: input.folder,
      collectionId: input.collectionId,
      metadata: input.metadata,
      signal: input.signal,
    });
    if (session.completed && session.asset) return session.asset;

    for (let offset = 0, partNumber = 1; offset < blob.size; offset += session.part_size, partNumber++) {
      const part = blob.slice(offset, Math.min(offset + session.part_size, blob.size));
      await this.uploadPart(session.upload_id, partNumber, part, {
        sha256: input.idempotencyKey ? await sha256(part) : undefined,
        signal: input.signal,
      });
    }
    return this.completeUpload(session.upload_id, {
      socialReady: input.socialReady,
      signExpiresIn: input.signExpiresIn,
      signal: input.signal,
    });
  }

  async list(params: VideoListParams = {}): Promise<{ data: Video[]; meta: VideoListMeta }> {
    const response = await request<{ data?: Video[]; meta?: VideoListMeta }>(this.cfg, {
      method: "GET",
      path: "/v1/videos",
      query: {
        page: params.page,
        per_page: params.perPage,
        folder: params.folder,
        collection_id: params.collectionId,
        metadata: params.metadata && Object.keys(params.metadata).length > 0
          ? JSON.stringify(params.metadata)
          : undefined,
      },
      signal: params.signal,
    });
    return {
      data: response.data ?? [],
      meta: response.meta ?? { total: 0, page: params.page ?? 1, per_page: params.perPage ?? 0 },
    };
  }

  async *listAll(params: Omit<VideoListParams, "page"> = {}): AsyncGenerator<Video> {
    for (let page = 1; ; page++) {
      const { data, meta } = await this.list({ ...params, page });
      yield* data;
      const perPage = meta.per_page || data.length;
      if (data.length === 0 || page * perPage >= meta.total) return;
    }
  }

  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<Video> {
    const response = await request<{ data: Video }>(this.cfg, {
      method: "GET",
      path: `/v1/videos/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
    return response.data;
  }

  async update(id: string, input: UpdateVideoInput): Promise<Video> {
    const response = await request<{ data: Video }>(this.cfg, {
      method: "PATCH",
      path: `/v1/videos/${encodeURIComponent(id)}`,
      json: {
        metadata: input.metadata,
        folder: input.folder,
        collection_id: input.collectionId,
      },
      signal: input.signal,
    });
    return response.data;
  }

  async delete(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/videos/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }

  async signUrl(
    id: string,
    opts: { expiresIn?: number; signal?: AbortSignal } = {},
  ): Promise<VideoSignedUrls> {
    const response = await request<{ data: VideoSignedUrls }>(this.cfg, {
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/sign-url`,
      json: opts.expiresIn === undefined ? {} : { expires_in: opts.expiresIn },
      signal: opts.signal,
    });
    return response.data;
  }

  async optimize(id: string, opts: { signal?: AbortSignal } = {}): Promise<Video> {
    const response = await request<{ data: Video }>(this.cfg, {
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/optimize`,
      signal: opts.signal,
    });
    return response.data;
  }

  async enrich(id: string, opts: { signal?: AbortSignal } = {}): Promise<Video> {
    const response = await request<{ data: Video }>(this.cfg, {
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/enrich`,
      signal: opts.signal,
    });
    return response.data;
  }

  async analyze(id: string, opts: { signal?: AbortSignal } = {}): Promise<Video> {
    const response = await request<{ data: Video }>(this.cfg, {
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/analyze`,
      signal: opts.signal,
    });
    return response.data;
  }

  async createPoster(id: string, opts: { signal?: AbortSignal } = {}): Promise<Video> {
    const response = await request<{ data: Video }>(this.cfg, {
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/poster`,
      signal: opts.signal,
    });
    return response.data;
  }

  async waitForEnrichment(id: string, opts: VideoWaitOptions = {}): Promise<VideoWaitResult> {
    return this.waitForJob(id, "enrichment", opts);
  }

  async waitForOptimization(id: string, opts: VideoWaitOptions = {}): Promise<VideoWaitResult> {
    return this.waitForJob(id, "optimization", opts);
  }

  private async waitForJob(
    id: string,
    job: VideoJob,
    opts: VideoWaitOptions,
  ): Promise<VideoWaitResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const maxInterval = opts.maxIntervalMs ?? 5_000;
    let interval = opts.initialIntervalMs ?? 1_000;
    for (;;) {
      const video = await this.get(id, { signal: opts.signal });
      const rawStatus = job === "enrichment"
        ? video.enrichment.status
        : video.social_optimization.status;
      const status = rawStatus as VideoJobStatus;
      if (!["pending", "processing"].includes(status)) {
        return { video, status, timedOut: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { video, status, timedOut: true };
      await sleep(Math.min(interval, remaining), opts.signal);
      interval = Math.min(Math.ceil(interval * 1.5), maxInterval);
    }
  }
}
