import { request, type HttpConfig } from "./http.js";

export type TransformFit = "scale-down" | "contain" | "cover" | "crop" | "pad";
export type TransformFormat = "auto" | "webp" | "avif" | "jpg" | "jpeg" | "png";
export type TransformQuality = "auto" | "60" | "75" | "85" | 60 | 75 | 85;
export type TransformMetadata = "none" | "copyright" | "keep";
export type TransformOverlayPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"
  | "center";

export interface TransformParams {
  w?: number;
  h?: number;
  fit?: TransformFit;
  fmt?: TransformFormat;
  q?: TransformQuality;
  dpr?: number | string;
  trim?: "border" | "auto";
  anim?: boolean | "true" | "false";
  metadata?: TransformMetadata;
  segment?: "foreground";
  background?: string;
  gravity?: string;
  zoom?: number | string;
  blur?: number | string;
  sharpen?: number | string;
  rotate?: number | string;
  flip?: "h" | "v" | "hv";
  brightness?: number | string;
  contrast?: number | string;
  saturation?: number | string;
  tile?: string;
  watermark?: string;
  watermark_pos?: TransformOverlayPosition;
  watermark_opacity?: number | string;
  watermark_width?: number;
  text?: string;
  text_color?: string;
  text_size?: number;
  text_pos?: TransformOverlayPosition;
  text_opacity?: number | string;
}

export interface SignUrlTransforms extends TransformParams {
  /** Built-in (`s`, `m`, `l`, `social`, `square`, `portrait`) or custom preset name. */
  size?: string;
}

export interface TransformPreset {
  name: string;
  params: TransformParams;
  created_at: string;
  updated_at: string;
}

export interface TransformPresetMeta {
  limit: number;
  total: number;
  strict_transforms: boolean;
  builtin_presets: string[];
}

export class PresetsResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** List custom named transform presets, plan capacity, and strict-mode state. */
  async list(opts: { signal?: AbortSignal } = {}): Promise<{
    data: TransformPreset[];
    meta: TransformPresetMeta;
  }> {
    return request(this.cfg, {
      method: "GET",
      path: "/v1/presets",
      signal: opts.signal,
    });
  }

  /** Create or update a named transform preset (`?size=<name>`). */
  async upsert(
    name: string,
    params: TransformParams,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TransformPreset> {
    const res = await request<{ data: TransformPreset }>(this.cfg, {
      method: "PUT",
      path: `/v1/presets/${encodeURIComponent(name)}`,
      json: { params },
      signal: opts.signal,
    });
    return res.data;
  }

  /** Delete a custom named transform preset. */
  async delete(name: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/presets/${encodeURIComponent(name)}`,
      signal: opts.signal,
    });
  }
}
