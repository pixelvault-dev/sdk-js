import { request, type HttpConfig } from "./http.js";

export type AudioVisibility = "public" | "private";
export type AudioContainer = "mp3" | "wav" | "m4a" | "ogg";
export type AudioCodec = "mp3" | "pcm" | "pcm_float" | "aac" | "opus" | "vorbis";
export type AudioContentType = "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg";
export type AudioFileInput = Blob | ArrayBuffer | Uint8Array;
export type AudioEnrichmentStatus = "not_requested" | "pending" | "processing" | "complete" | "failed";

export interface AudioTranscript {
  status: "complete";
  text_url?: string;
  vtt_url?: string;
  segments_url?: string;
  language?: string | null;
  languages?: string[];
  model?: string | null;
  segment_count?: number;
}

export interface AudioEnrichment {
  job_id?: string;
  status: AudioEnrichmentStatus;
  requested_at?: string;
  completed_at?: string | null;
  transcript?: AudioTranscript | null;
  error?: { code: string; message: string };
}

const AUDIO_MAX_BYTES = 25_000_000;

export interface Audio {
  id: string;
  kind: "audio";
  url: string;
  original_url: string;
  branded_url?: string;
  visibility: AudioVisibility;
  mime_type: AudioContentType;
  size: number;
  container: AudioContainer;
  codec: AudioCodec;
  duration_seconds: number;
  sample_rate: number;
  channels: number;
  filename: string;
  folder: string | null;
  collection_id: string | null;
  metadata: Record<string, unknown> | null;
  enrichment: AudioEnrichment;
  created_at: string;
  expires_at?: string;
  temporary?: true;
  signed_expires?: number;
  replayed?: true;
}

export interface AudioLifecycleOptions {
  visibility?: AudioVisibility;
  signExpiresIn?: number;
  expiresIn?: number;
  folder?: string;
  collectionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AudioUploadOptions extends AudioLifecycleOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface UploadAudioFileInput extends AudioUploadOptions {
  file: AudioFileInput;
  filename?: string;
  contentType?: AudioContentType;
  /** Lowercase hex digest. Required with idempotencyKey; computed when omitted. */
  sha256?: string;
}

export interface ImportAudioInput extends AudioUploadOptions {
  url: string;
  filename?: string;
}

export interface AudioListParams {
  page?: number;
  perPage?: number;
  folder?: string;
  collectionId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AudioListMeta {
  total: number;
  page: number;
  per_page: number;
}

export interface UpdateAudioInput {
  metadata?: Record<string, unknown> | null;
  folder?: string | null;
  collectionId?: string | null;
  signal?: AbortSignal;
}

export interface AudioSignedUrl {
  url: string;
  branded_url?: string;
  original_url: string;
  expires: number;
  visibility: AudioVisibility;
  enrichment: AudioEnrichment;
}

export interface AudioWaitOptions {
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
}

export interface AudioWaitResult {
  audio: Audio;
  status: AudioEnrichmentStatus;
  timedOut: boolean;
}

function canonicalContentType(value: string | undefined): AudioContentType | undefined {
  if (value === "audio/mpeg" || value === "audio/mp3") return "audio/mpeg";
  if (value === "audio/wav" || value === "audio/x-wav") return "audio/wav";
  if (value === "audio/mp4" || value === "audio/m4a" || value === "audio/x-m4a") return "audio/mp4";
  if (value === "audio/ogg" || value === "application/ogg") return "audio/ogg";
  return undefined;
}

function contentTypeFromFilename(filename: string): AudioContentType | undefined {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "ogg") return "audio/ogg";
  return undefined;
}

function toBlob(
  file: AudioFileInput,
  filename?: string,
  contentType?: AudioContentType,
): { blob: Blob; filename: string; contentType: AudioContentType } {
  const named = file instanceof Blob ? file as Blob & { name?: string } : undefined;
  const resolvedFilename = filename ?? named?.name ?? "audio.mp3";
  const resolvedContentType = canonicalContentType(contentType)
    ?? canonicalContentType(named?.type)
    ?? contentTypeFromFilename(resolvedFilename);
  if (!resolvedContentType) {
    throw new TypeError("Audio uploads require an MP3, WAV, M4A, or OGG filename/content type.");
  }
  if (file instanceof Blob) {
    return { blob: file, filename: resolvedFilename, contentType: resolvedContentType };
  }
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  return {
    blob: new Blob([bytes as BlobPart], { type: resolvedContentType }),
    filename: resolvedFilename,
    contentType: resolvedContentType,
  };
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  let result = "";
  for (const byte of new Uint8Array(digest)) result += byte.toString(16).padStart(2, "0");
  return result;
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

function lifecycleJson(input: AudioLifecycleOptions): Record<string, unknown> {
  return {
    visibility: input.visibility,
    sign_expires_in: input.signExpiresIn,
    expires_in: input.expiresIn,
    folder: input.folder,
    collection_id: input.collectionId,
    metadata: input.metadata,
  };
}

export class AudioResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** Upload original audio bytes or securely import a public HTTP(S) audio URL. */
  async upload(input: UploadAudioFileInput | ImportAudioInput): Promise<Audio> {
    if ("url" in input) {
      const response = await request<{ data: Audio }>(this.cfg, {
        method: "POST",
        path: "/v1/audio",
        headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
        json: { url: input.url, filename: input.filename, ...lifecycleJson(input) },
        signal: input.signal,
      });
      return response.data;
    }

    const { blob, filename, contentType } = toBlob(input.file, input.filename, input.contentType);
    if (blob.size > AUDIO_MAX_BYTES) {
      throw new RangeError(
        `Audio originals are limited to the approved global maximum of ${AUDIO_MAX_BYTES.toLocaleString("en-US")} bytes; this is not a plan allowance.`,
      );
    }
    const digest = input.sha256 ?? (input.idempotencyKey ? await sha256(blob) : undefined);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-PixelVault-Filename": encodeURIComponent(filename),
    };
    if (input.visibility) headers["X-PixelVault-Visibility"] = input.visibility;
    if (input.signExpiresIn !== undefined) headers["X-PixelVault-Sign-Expires-In"] = String(input.signExpiresIn);
    if (input.expiresIn !== undefined) headers["X-PixelVault-Expires-In"] = String(input.expiresIn);
    if (input.folder) headers["X-PixelVault-Folder"] = input.folder;
    if (input.collectionId) headers["X-PixelVault-Collection-Id"] = input.collectionId;
    if (input.metadata !== undefined) headers["X-PixelVault-Metadata"] = JSON.stringify(input.metadata);
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    if (digest) headers["X-PixelVault-Content-SHA256"] = digest;

    const response = await request<{ data: Audio }>(this.cfg, {
      method: "POST",
      path: "/v1/audio",
      headers,
      body: blob,
      signal: input.signal,
    });
    return response.data;
  }

  async list(params: AudioListParams = {}): Promise<{ data: Audio[]; meta: AudioListMeta }> {
    const response = await request<{ data?: Audio[]; meta?: AudioListMeta }>(this.cfg, {
      method: "GET",
      path: "/v1/audio",
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

  async *listAll(params: Omit<AudioListParams, "page"> = {}): AsyncGenerator<Audio> {
    for (let page = 1; ; page++) {
      const { data, meta } = await this.list({ ...params, page });
      yield* data;
      const perPage = meta.per_page || data.length;
      if (data.length === 0 || page * perPage >= meta.total) return;
    }
  }

  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<Audio> {
    const response = await request<{ data: Audio }>(this.cfg, {
      method: "GET",
      path: `/v1/audio/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
    return response.data;
  }

  async update(id: string, input: UpdateAudioInput): Promise<Audio> {
    const response = await request<{ data: Audio }>(this.cfg, {
      method: "PATCH",
      path: `/v1/audio/${encodeURIComponent(id)}`,
      json: { metadata: input.metadata, folder: input.folder, collection_id: input.collectionId },
      signal: input.signal,
    });
    return response.data;
  }

  async delete(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/audio/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }

  async signUrl(
    id: string,
    opts: { expiresIn?: number; signal?: AbortSignal } = {},
  ): Promise<AudioSignedUrl> {
    const response = await request<{ data: AudioSignedUrl }>(this.cfg, {
      method: "POST",
      path: `/v1/audio/${encodeURIComponent(id)}/sign-url`,
      json: opts.expiresIn === undefined ? {} : { expires_in: opts.expiresIn },
      signal: opts.signal,
    });
    return response.data;
  }
  /** Start or resume transcription. Pending, processing, and complete jobs are reused. */
  async enrich(id: string, opts: { signal?: AbortSignal } = {}): Promise<Audio> {
    const response = await request<{ data: Audio }>(this.cfg, {
      method: "POST",
      path: `/v1/audio/${encodeURIComponent(id)}/enrich`,
      signal: opts.signal,
    });
    return response.data;
  }

  /**
   * Poll until transcription completes or fails. A local timeout does not cancel the server job.
   * Reuse the same asset ID to resume.
   */
  async waitForEnrichment(id: string, opts: AudioWaitOptions = {}): Promise<AudioWaitResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const maxInterval = opts.maxIntervalMs ?? 5_000;
    let interval = opts.initialIntervalMs ?? 1_000;
    for (;;) {
      const audio = await this.get(id, { signal: opts.signal });
      const status = audio.enrichment.status;
      if (status !== "pending" && status !== "processing") {
        return { audio, status, timedOut: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { audio, status, timedOut: true };
      await sleep(Math.min(interval, remaining), opts.signal);
      interval = Math.min(Math.ceil(interval * 1.5), maxInterval);
    }
  }
}
