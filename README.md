# @pixelvault-dev/sdk

Official JavaScript/TypeScript SDK for [PixelVault](https://pixelvault.dev), agent-first image hosting.
Zero dependencies. Works in Node 18+, Cloudflare Workers, Deno, Bun and browsers (use a publishable key there).

```bash
npm install @pixelvault-dev/sdk
```

## Quick start

```ts
import { PixelVault } from "@pixelvault-dev/sdk";

const pv = new PixelVault({ apiKey: process.env.PIXELVAULT_API_KEY });

// Bytes (Buffer, Uint8Array, Blob/File)
const image = await pv.images.upload({ file: bytes, filename: "shot.png", contentType: "image/png" });
console.log(image.url); // https://img.pixelvault.dev/...

// Import from a URL, auto-delete after one hour
await pv.images.upload({ url: "https://example.com/a.png", expiresIn: 3600 });
```

`apiKey` falls back to the `PIXELVAULT_API_KEY` environment variable. With no key at all, `images.upload({ file })`
makes an anonymous upload that expires after 30 days.

## API

| Call | What it does |
|---|---|
| `pv.images.upload({ file \| url, folder?, visibility?, expiresIn?, signExpiresIn? })` | Upload bytes or import a URL |
| `pv.images.uploadBatch({ collection, images })` | Up to 50 images in one collection |
| `pv.images.list({ page?, perPage? })` / `pv.images.listAll()` | One page / async iterator over all images |
| `pv.images.get(id)` / `pv.images.delete(id)` | Fetch / delete one image |
| `pv.images.signUrl(id, { expiresIn? })` | Signed URL for a private image |
| `pv.usage.get()` | Plan, usage, limits and what is left this month |
| `pv.keys.list()` / `.create({ label?, environment? })` / `.revoke(id)` | Manage your API keys (secret keys only) |
| `pv.register({ email })` | Create an account, returns a first key once |
| `pv.deviceLoginStart({ email })` + `pv.deviceLoginComplete({ email, code })` | Passwordless key minting |

Every call accepts an optional `signal` (`AbortSignal`). Image URLs support on-the-fly transforms through query
parameters (`?w=800&fmt=auto`), see the [docs](https://pixelvault.dev/docs).

## Errors and retries

All failures throw `PixelVaultError` with `status` (0 for network errors), `code` (for example
`upload_limit_reached`) and `retryAfter` (seconds, when sent).

```ts
try {
  await pv.images.upload({ file });
} catch (err) {
  if (err instanceof PixelVaultError && err.code === "upload_limit_reached") {
    // err.message links to the pricing page
  }
}
```

The client retries `429` (honoring `Retry-After` up to 30 seconds) and, for `GET`/`DELETE` only, `5xx` and network
errors. Uploads are never retried after a `5xx`, so a lost response cannot create a duplicate image. Tune with
`maxRetries` (default 2) and `timeoutMs` (default 60000).

## Types

Response types are generated from the live OpenAPI spec (`spec/openapi.json`). CI re-syncs the spec on every run and
fails if the checked-in copy has drifted, so the types track the API.

## License

MIT
