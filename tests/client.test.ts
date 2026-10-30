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
