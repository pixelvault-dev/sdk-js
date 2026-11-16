import { request, type HttpConfig } from "./http.js";

export interface ExportStart {
  job_id: string;
  status: string;
  image_count: number;
  video_count: number;
  audio_count: number;
  asset_count: number;
  status_url: string;
}

export interface ExportJob {
  id: string;
  status: "pending" | "processing" | "complete" | "failed" | "expired";
  image_count: number;
  video_count: number;
  audio_count: number;
  asset_count: number;
  processed_count: number;
  bytes: number;
  created_at: string;
  expires_at: string;
  download_url?: string;
  error?: string;
}

export interface ExportWaitOptions {
  projectId?: string;
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ExportWaitResult {
  job: ExportJob;
  timedOut: boolean;
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

export class ExportsResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** Export every non-expired image, video, audio original, and available derivative with manifest relationships. */
  async start(opts: { projectId?: string; signal?: AbortSignal } = {}): Promise<ExportStart> {
    return request<ExportStart>(this.cfg, {
      method: "POST",
      path: "/v1/export",
      query: { project_id: opts.projectId },
      signal: opts.signal,
    });
  }

  async get(
    jobId: string,
    opts: { projectId?: string; signal?: AbortSignal } = {},
  ): Promise<ExportJob> {
    return request<ExportJob>(this.cfg, {
      method: "GET",
      path: `/v1/export-jobs/${encodeURIComponent(jobId)}`,
      query: { project_id: opts.projectId },
      signal: opts.signal,
    });
  }

  async download(
    jobId: string,
    opts: { projectId?: string; signal?: AbortSignal } = {},
  ): Promise<ArrayBuffer> {
    return request<ArrayBuffer>(this.cfg, {
      method: "GET",
      path: `/v1/export-jobs/${encodeURIComponent(jobId)}/download`,
      query: { project_id: opts.projectId },
      headers: { Accept: "application/x-tar" },
      responseType: "arrayBuffer",
      signal: opts.signal,
    });
  }

  async wait(jobId: string, opts: ExportWaitOptions = {}): Promise<ExportWaitResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const maxInterval = opts.maxIntervalMs ?? 5_000;
    let interval = opts.initialIntervalMs ?? 1_000;
    for (;;) {
      const job = await this.get(jobId, { projectId: opts.projectId, signal: opts.signal });
      if (!["pending", "processing"].includes(job.status)) return { job, timedOut: false };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { job, timedOut: true };
      await sleep(Math.min(interval, remaining), opts.signal);
      interval = Math.min(Math.ceil(interval * 1.5), maxInterval);
    }
  }
}
