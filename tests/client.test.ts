import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PixelVault, PixelVaultError, VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const IMG = { id: "img_1", url: "https://img.pixelvault.dev/p/i.png", filename: "a.png" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetchImpl: typeof fetch, extra = {}) {
  return new PixelVault({ apiKey: "pv_live_test", fetch: fetchImpl, ...extra });
}

describe("version", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe("images.upload", () => {
  it("sends multipart with auth and client headers", async () => {
    const f = vi.fn(async () => json({ data: IMG }, 201));
    const img = await client(f as unknown as typeof fetch).images.upload({
      file: new Uint8Array([1, 2, 3]),
      filename: "a.png",
      contentType: "image/png",
      expiresIn: 3600,
      visibility: "private",
    });
    expect(img.id).toBe("img_1");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.pixelvault.dev/v1/images");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer pv_live_test");
    expect(headers["X-PixelVault-Client"]).toBe(`sdk-js/${VERSION}`);
    const form = init.body as FormData;
    expect((form.get("file") as File).name).toBe("a.png");
    expect(form.get("expires_in")).toBe("3600");
    expect(form.get("visibility")).toBe("private");
  });

  it("imports by url as JSON with snake_case fields", async () => {
    const f = vi.fn(async () => json({ data: IMG }, 201));
    await client(f as unknown as typeof fetch).images.upload({
      url: "https://example.com/x.png",
      expiresIn: 60,
      signExpiresIn: 120,
    });
    const init = (f.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({
      url: "https://example.com/x.png",
      expires_in: 60,
      sign_expires_in: 120,
    });
  });

  it("omits Authorization when no key is configured (anonymous upload)", async () => {
    const f = vi.fn(async () => json({ data: IMG }, 201));
    const pv = new PixelVault({ fetch: f as unknown as typeof fetch, apiKey: "" });
    await pv.images.upload({ file: new Blob(["x"], { type: "image/png" }) });
    const init = (f.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("does not retry a 5xx on upload (no duplicate images)", async () => {
    const f = vi.fn(async () => json({ error: { code: "internal", message: "boom" } }, 500));
    await expect(
      client(f as unknown as typeof fetch).images.upload({ file: new Uint8Array([1]) })
    ).rejects.toMatchObject({ status: 500, code: "internal" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("errors and retries", () => {
  it("maps API errors to PixelVaultError", async () => {
    const f = vi.fn(async () =>
      json({ error: { code: "upload_limit_reached", message: "Upgrade at pixelvault.dev/pricing" } }, 429, {
        "Retry-After": "3600",
      })
    );
    const err = await client(f as unknown as typeof fetch).usage.get().catch((e) => e);
    expect(err).toBeInstanceOf(PixelVaultError);
    expect(err).toMatchObject({ status: 429, code: "upload_limit_reached", retryAfter: 3600 });
    // Retry-After of an hour is not worth waiting on, so it fails fast.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 429 with a short Retry-After and succeeds", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: "rate_limited", message: "slow" } }, 429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(json({ data: { plan: "free" } }));
    const u = await client(f as unknown as typeof fetch).usage.get();
    expect(u.plan).toBe("free");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries GET on 5xx", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: "x", message: "y" } }, 503))
      .mockResolvedValueOnce(json({ data: IMG }));
    const img = await client(f as unknown as typeof fetch, { maxRetries: 1 }).images.get("img_1");
    expect(img.id).toBe("img_1");
  });

  it("wraps network failures", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      client(f as unknown as typeof fetch, { maxRetries: 0 }).images.delete("img_1")
    ).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
});

describe("images.list / listAll", () => {
  it("passes paging params", async () => {
    const f = vi.fn(async () => json({ data: [IMG], meta: { total: 1, page: 2, per_page: 5 } }));
    const r = await client(f as unknown as typeof fetch).images.list({ page: 2, perPage: 5 });
    expect(r.meta.total).toBe(1);
    const url = (f.mock.calls[0] as unknown as [URL])[0];
    expect(url.search).toBe("?page=2&per_page=5");
  });

  it("walks every page", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ ...IMG, id: "a" }, { ...IMG, id: "b" }], meta: { total: 3, page: 1, per_page: 2 } }))
      .mockResolvedValueOnce(json({ data: [{ ...IMG, id: "c" }], meta: { total: 3, page: 2, per_page: 2 } }));
    const ids: string[] = [];
    for await (const i of client(f as unknown as typeof fetch).images.listAll({ perPage: 2 })) ids.push(i.id!);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("keys and auth", () => {
  it("creates a key with the documented body", async () => {
    const f = vi.fn(async () => json({ data: { id: "key_1", api_key: "pv_live_new" } }, 201));
    const k = await client(f as unknown as typeof fetch).keys.create({ label: "ci", environment: "test" });
    expect(k.api_key).toBe("pv_live_new");
    const init = (f.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ label: "ci", environment: "test" });
  });

  it("device login never sends the Authorization header", async () => {
    const f = vi.fn(async () => json({ data: { api_key: "pv_live_x" } }));
    await client(f as unknown as typeof fetch).deviceLoginComplete({
      email: "a@b.co",
      code: "123456",
      replaceExisting: true,
    });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toMatchObject({ replace_existing: true });
  });

  it("URL-encodes ids", async () => {
    const f = vi.fn(async () => json({ data: { deleted: true } }));
    await client(f as unknown as typeof fetch).keys.revoke("key/1");
    expect((f.mock.calls[0] as unknown as [URL])[0].pathname).toBe("/v1/keys/key%2F1");
  });
});

const GENERATED = {
  ...IMG,
  optimized_url: "https://img.pixelvault.dev/p/i.png?fmt=auto&q=85",
  generation: { model: "flux-1-schnell", credits_charged: 1, credits_remaining: 9 },
};

describe("images.generate", () => {
  it("POSTs the prompt as JSON with snake_case options and returns the generation block", async () => {
    const f = vi.fn(async () => json({ data: GENERATED }, 201));
    const img = await client(f as unknown as typeof fetch).images.generate({
      prompt: "a red bicycle",
      model: "lucid-origin",
      folder: "heroes",
      expiresIn: 3600,
      visibility: "private",
      signExpiresIn: 600,
    });
    expect(img.generation.credits_remaining).toBe(9);
    expect(img.optimized_url).toContain("fmt=auto");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.pixelvault.dev/v1/images/generate");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer pv_live_test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "a red bicycle",
      model: "lucid-origin",
      folder: "heroes",
      expires_in: 3600,
      visibility: "private",
      sign_expires_in: 600,
    });
  });

  it("sends only the prompt when no options are set", async () => {
    const f = vi.fn(async () => json({ data: GENERATED }, 201));
    await client(f as unknown as typeof fetch).images.generate({ prompt: "a lake" });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ prompt: "a lake" });
  });

  it("surfaces credit exhaustion with the API's code", async () => {
    const f = vi.fn(async () =>
      json({ error: { code: "generation_credits_exhausted", message: "0 left" } }, 402),
    );
    const err = await client(f as unknown as typeof fetch)
      .images.generate({ prompt: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PixelVaultError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("generation_credits_exhausted");
  });

  it("is never retried after a 5xx, so a lost response cannot spend credits twice", async () => {
    const f = vi.fn(async () =>
      json({ error: { code: "generation_failed", message: "try again" } }, 502),
    );
    await expect(
      client(f as unknown as typeof fetch).images.generate({ prompt: "x" }),
    ).rejects.toMatchObject({ status: 502, code: "generation_failed" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("accepts a model id the SDK doesn't know yet", async () => {
    const f = vi.fn(async () => json({ data: GENERATED }, 201));
    await client(f as unknown as typeof fetch).images.generate({ prompt: "x", model: "future-model-9" });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("future-model-9");
  });
});

describe("usage.get", () => {
  it("exposes generation credits", async () => {
    const f = vi.fn(async () =>
      json({
        data: {
          plan: "free",
          generation: { credits_used: 1, credits_limit: 10, credits_remaining: 9 },
        },
      }),
    );
    const u = await client(f as unknown as typeof fetch).usage.get();
    expect(u.generation?.credits_remaining).toBe(9);
  });
});

describe("image metadata", () => {
  it("sends metadata as a JSON string in multipart uploads", async () => {
    const f = vi.fn(async () => json({ data: IMG }, 201));
    await client(f as unknown as typeof fetch).images.upload({
      file: new Uint8Array([1]),
      filename: "a.png",
      metadata: { env: "prod", n: 3 },
    });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse((init.body as FormData).get("metadata") as string)).toEqual({ env: "prod", n: 3 });
  });

  it("sends metadata in the JSON body for url imports", async () => {
    const f = vi.fn(async () => json({ data: IMG }, 201));
    await client(f as unknown as typeof fetch).images.upload({ url: "https://example.com/a.png", metadata: { a: 1 } });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ url: "https://example.com/a.png", metadata: { a: 1 } });
  });

  it("list/listAll send the metadata filter as a JSON query param and omit it when empty", async () => {
    const f = vi.fn(async () => json({ data: [], meta: { total: 0, page: 1, per_page: 20 } }));
    const pv = client(f as unknown as typeof fetch);
    await pv.images.list({ metadata: { env: "prod" } });
    const url = (f.mock.calls[0] as unknown as [URL])[0];
    expect(JSON.parse(url.searchParams.get("metadata") as string)).toEqual({ env: "prod" });
    await pv.images.list({ metadata: {} });
    expect((f.mock.calls[1] as unknown as [URL])[0].searchParams.has("metadata")).toBe(false);
    for await (const _ of pv.images.listAll({ metadata: { a: 1 } })) void _;
    expect((f.mock.calls[2] as unknown as [URL])[0].searchParams.get("metadata")).toBe('{"a":1}');
  });

  it("updateMetadata PATCHes the object (or null) and returns the stored value", async () => {
    const f = vi.fn(async (_u: URL, init: RequestInit) =>
      json({ data: { id: "img_1", metadata: JSON.parse(String(init.body)).metadata } }),
    );
    const pv = client(f as unknown as typeof fetch);
    expect(await pv.images.updateMetadata("img_1", { a: 1 })).toEqual({ a: 1 });
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/images/img_1");
    expect(init.method).toBe("PATCH");
    expect(await pv.images.updateMetadata("img_1", null)).toBeNull();
  });
});

describe("AI descriptions", () => {
  it("sends describe=true in multipart and JSON uploads, only when set", async () => {
    const f = vi.fn(async () => json({ data: IMG }, 201));
    const pv = client(f as unknown as typeof fetch);
    await pv.images.upload({ file: new Uint8Array([1]), filename: "a.png", describe: true });
    await pv.images.upload({ file: new Uint8Array([1]), filename: "a.png" });
    await pv.images.upload({ url: "https://example.com/a.png", describe: true });
    await pv.images.upload({ url: "https://example.com/a.png" });
    const call = (i: number) => (f.mock.calls[i] as unknown as [URL, RequestInit])[1];
    expect((call(0).body as FormData).get("describe")).toBe("true");
    expect((call(1).body as FormData).get("describe")).toBeNull();
    expect(JSON.parse(call(2).body as string).describe).toBe(true);
    expect(JSON.parse(call(3).body as string)).not.toHaveProperty("describe");
  });

  it("list/listAll send q and omit it when blank", async () => {
    const f = vi.fn(async () => json({ data: [], meta: { total: 0, page: 1, per_page: 20 } }));
    const pv = client(f as unknown as typeof fetch);
    await pv.images.list({ q: "invoice 4821" });
    expect((f.mock.calls[0] as unknown as [URL])[0].searchParams.get("q")).toBe("invoice 4821");
    await pv.images.list({ q: "  " });
    expect((f.mock.calls[1] as unknown as [URL])[0].searchParams.has("q")).toBe(false);
    for await (const _ of pv.images.listAll({ q: "cat" })) void _;
    expect((f.mock.calls[2] as unknown as [URL])[0].searchParams.get("q")).toBe("cat");
  });

  it("waitForDescription polls until done, returns failed/null immediately, gives up at the timeout", async () => {
    const states = [{ status: "pending" }, { status: "pending" }, { status: "done", alt: "A cat" }];
    let i = 0;
    const f = vi.fn(async () => json({ data: { ...IMG, description: states[Math.min(i++, states.length - 1)] } }));
    const pv = client(f as unknown as typeof fetch);
    const done = await pv.images.waitForDescription("img_1", { intervalMs: 1 });
    expect(done).toMatchObject({ status: "done", alt: "A cat" });
    expect(f).toHaveBeenCalledTimes(3);

    const failed = vi.fn(async () => json({ data: { ...IMG, description: { status: "failed", error: "describe_timeout" } } }));
    expect(await client(failed as unknown as typeof fetch).images.waitForDescription("img_1", { intervalMs: 1 })).toMatchObject({ status: "failed" });
    const none = vi.fn(async () => json({ data: { ...IMG, description: null } }));
    expect(await client(none as unknown as typeof fetch).images.waitForDescription("img_1", { intervalMs: 1 })).toBeNull();

    const pending = vi.fn(async () => json({ data: { ...IMG, description: { status: "pending" } } }));
    expect(await client(pending as unknown as typeof fetch).images.waitForDescription("img_1", { intervalMs: 1, timeoutMs: 5 })).toMatchObject({ status: "pending" });
  });
});

const VIDEO = {
  id: "vid_1",
  kind: "video",
  url: "https://img.pixelvault.dev/p/vid_1.mp4",
  original_url: "https://img.pixelvault.dev/p/vid_1.mp4",
  visibility: "public",
  mime_type: "video/mp4",
  size: 3,
  width: 1920,
  height: 1080,
  duration_seconds: 2,
  video_codec: "h264",
  audio_codec: "aac",
  has_audio: true,
  fast_start: true,
  social_compatible: true,
  compatibility_warnings: [],
  social_optimization: { status: "not_requested" },
  enrichment: { status: "not_requested" },
  filename: "clip.mp4",
  folder: null,
  collection_id: null,
  metadata: null,
  created_at: "2026-11-16T00:00:00Z",
};

describe("videos", () => {
  it("uploads bytes with lifecycle and replay-safety headers", async () => {
    const f = vi.fn(async () => json({ data: VIDEO }, 201));
    const video = await client(f as unknown as typeof fetch).videos.upload({
      file: new Uint8Array([1, 2, 3]),
      filename: "hello world.mp4",
      visibility: "private",
      signExpiresIn: 300,
      expiresIn: 3600,
      folder: "demos",
      collectionId: "col_1",
      metadata: { env: "test" },
      socialReady: true,
      idempotencyKey: "retry-1",
      sha256: "abc123",
    });
    expect(video.id).toBe("vid_1");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/videos");
    expect(init.body).toBeInstanceOf(Blob);
    expect(init.headers).toMatchObject({
      "Content-Type": "video/mp4",
      "X-PixelVault-Filename": "hello%20world.mp4",
      "X-PixelVault-Visibility": "private",
      "X-PixelVault-Sign-Expires-In": "300",
      "X-PixelVault-Expires-In": "3600",
      "X-PixelVault-Social-Ready": "true",
      "X-PixelVault-Folder": "demos",
      "X-PixelVault-Collection-Id": "col_1",
      "X-PixelVault-Metadata": "{\"env\":\"test\"}",
      "Idempotency-Key": "retry-1",
      "X-PixelVault-Content-SHA256": "abc123",
    });
  });

  it("imports an HTTPS video with the API field names", async () => {
    const f = vi.fn(async () => json({ data: VIDEO }, 201));
    await client(f as unknown as typeof fetch).videos.upload({
      url: "https://example.com/clip.mp4",
      filename: "clip.mp4",
      idempotencyKey: "import-1",
      metadata: { source: "demo" },
      socialReady: false,
    });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toMatchObject({ "Idempotency-Key": "import-1" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      url: "https://example.com/clip.mp4",
      filename: "clip.mp4",
      social_ready: false,
      metadata: { source: "demo" },
    });
  });

  it("supports resumable initiation, replay-safe parts, completion, and abort", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { upload_id: "vup_1", asset_id: "vid_1", part_size: 2, size: 3, visibility: "private", expires_at: "2026-11-16T01:00:00Z" } }, 201))
      .mockResolvedValueOnce(json({ data: { part_number: 1, etag: "a", received: 2 } }))
      .mockResolvedValueOnce(json({ data: { part_number: 2, etag: "b", received: 1 } }))
      .mockResolvedValueOnce(json({ data: VIDEO }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const pv = client(f as unknown as typeof fetch);
    const session = await pv.videos.createUpload({
      filename: "clip.mp4",
      size: 3,
      sha256: "whole",
      idempotencyKey: "resume-1",
      visibility: "private",
    });
    await pv.videos.uploadPart(session.upload_id, 1, new Uint8Array([1, 2]), { sha256: "part-1" });
    await pv.videos.uploadPart(session.upload_id, 2, new Uint8Array([3]));
    const completed = await pv.videos.completeUpload(session.upload_id, { socialReady: true, signExpiresIn: 120 });
    await pv.videos.abortUpload("vup_old");
    expect(completed.id).toBe("vid_1");
    expect((f.mock.calls[1] as unknown as [URL, RequestInit])[1]).toMatchObject({ method: "PUT" });
    expect((f.mock.calls[1] as unknown as [URL, RequestInit])[1].headers).toMatchObject({
      "X-PixelVault-Part-SHA256": "part-1",
    });
    expect((f.mock.calls[3] as unknown as [URL, RequestInit])[1].headers).toMatchObject({
      "X-PixelVault-Social-Ready": "true",
      "X-PixelVault-Sign-Expires-In": "120",
    });
  });

  it("runs the resumable convenience flow and replays each part safely", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { upload_id: "vup_1", asset_id: "vid_1", part_size: 2, size: 3, visibility: "public", expires_at: "2026-11-16T01:00:00Z" } }, 201))
      .mockResolvedValueOnce(json({ data: { part_number: 1, etag: "a", received: 2 } }))
      .mockResolvedValueOnce(json({ data: { part_number: 2, etag: "b", received: 1 } }))
      .mockResolvedValueOnce(json({ data: VIDEO }, 201));
    const video = await client(f as unknown as typeof fetch).videos.uploadResumable({
      file: new Uint8Array([1, 2, 3]),
      filename: "clip.mp4",
      idempotencyKey: "resume-1",
    });
    expect(video.id).toBe("vid_1");
    expect(f).toHaveBeenCalledTimes(4);
    expect((f.mock.calls[1] as unknown as [URL, RequestInit])[1].headers).toHaveProperty("X-PixelVault-Part-SHA256");
  });

  it("gets, filters, updates, signs, queues jobs, and deletes", async () => {
    const f = vi.fn(async (url: URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.pathname === "/v1/videos" && init?.method === "GET") {
        return json({ data: [VIDEO], meta: { total: 1, page: 1, per_page: 20 } });
      }
      if (url.pathname.endsWith("/sign-url")) {
        return json({ data: { url: "https://signed.example/video.mp4?sig=x", enrichment: VIDEO.enrichment, expires: 123 } });
      }
      return json({ data: VIDEO });
    });
    const pv = client(f as unknown as typeof fetch);
    await pv.videos.get("vid/1");
    await pv.videos.list({ folder: "demos", collectionId: "col_1", metadata: { env: "test" } });
    await pv.videos.update("vid_1", { metadata: null, folder: "archive", collectionId: null });
    const signed = await pv.videos.signUrl("vid_1", { expiresIn: 300 });
    await pv.videos.optimize("vid_1");
    await pv.videos.enrich("vid_1");
    await pv.videos.analyze("vid_1");
    await pv.videos.createPoster("vid_1");
    await pv.videos.delete("vid_1");

    expect((f.mock.calls[0] as unknown as [URL])[0].pathname).toBe("/v1/videos/vid%2F1");
    expect((f.mock.calls[1] as unknown as [URL])[0].search).toContain("metadata=%7B%22env%22%3A%22test%22%7D");
    expect(JSON.parse((f.mock.calls[2] as unknown as [URL, RequestInit])[1].body as string)).toEqual({
      metadata: null,
      folder: "archive",
      collection_id: null,
    });
    expect(JSON.parse((f.mock.calls[3] as unknown as [URL, RequestInit])[1].body as string)).toEqual({ expires_in: 300 });
    expect(signed).toMatchObject({ url: "https://signed.example/video.mp4?sig=x", expires: 123 });
    expect((f.mock.calls[5] as unknown as [URL])[0].pathname).toBe("/v1/videos/vid_1/enrich");
  });

  it("waits for terminal state and distinguishes a local timeout", async () => {
    const complete = { ...VIDEO, enrichment: { status: "complete", job_id: "ven_1" } };
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ data: complete }))
      .mockResolvedValueOnce(json({ data: { ...VIDEO, social_optimization: { status: "processing", job_id: "vop_1" } } }));
    const pv = client(f as unknown as typeof fetch);
    await expect(pv.videos.waitForEnrichment("vid_1", { timeoutMs: 0 })).resolves.toMatchObject({
      status: "complete",
      timedOut: false,
    });
    await expect(pv.videos.waitForOptimization("vid_1", { timeoutMs: 0 })).resolves.toMatchObject({
      status: "processing",
      timedOut: true,
    });
  });
});

describe("exports", () => {
  it("starts, waits for, and downloads media exports as bytes", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({
        job_id: "exp_1",
        status: "pending",
        image_count: 2,
        video_count: 1,
        asset_count: 3,
        status_url: "/v1/export-jobs/exp_1",
      }, 202))
      .mockResolvedValueOnce(json({
        id: "exp_1",
        status: "complete",
        image_count: 2,
        video_count: 1,
        asset_count: 3,
        processed_count: 3,
        bytes: 4,
        created_at: "2026-11-16T00:00:00Z",
        expires_at: "2026-11-17T00:00:00Z",
        download_url: "/v1/export-jobs/exp_1/download",
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "application/x-tar" },
      }));
    const pv = client(f as unknown as typeof fetch);
    const started = await pv.exports.start();
    const waited = await pv.exports.wait(started.job_id, { timeoutMs: 0 });
    const archive = await pv.exports.download(started.job_id);
    expect(started.video_count).toBe(1);
    expect(waited).toMatchObject({ timedOut: false, job: { status: "complete" } });
    expect(Array.from(new Uint8Array(archive))).toEqual([1, 2, 3, 4]);
    expect((f.mock.calls[2] as unknown as [URL, RequestInit])[1].headers).toMatchObject({
      Accept: "application/x-tar",
    });
  });
});
