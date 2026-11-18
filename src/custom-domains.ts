import { request, type HttpConfig } from "./http.js";

export interface CustomDomainVerification {
  type: "TXT";
  name: string;
  value: string;
}

export interface CustomDomain {
  id: string;
  project_id: string;
  hostname: string;
  status: string;
  hostname_status: string;
  certificate_status: string;
  ready: boolean;
  cname_target: string;
  ownership_verification: CustomDomainVerification | null;
  created_at: string;
  updated_at: string;
}

export interface CustomDomainCapacity {
  limit: number;
  total: number;
  project_total: number;
  cname_target: string;
}

export class CustomDomainsResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** List domains on the active project and account-wide plan capacity. */
  async list(opts: { signal?: AbortSignal } = {}): Promise<{
    data: CustomDomain[];
    meta: CustomDomainCapacity;
  }> {
    return request(this.cfg, {
      method: "GET",
      path: "/v1/custom-domains",
      signal: opts.signal,
    });
  }

  /** Attach a customer-owned hostname and return its required DNS records. */
  async create(hostname: string, opts: { signal?: AbortSignal } = {}): Promise<CustomDomain> {
    const response = await request<{ data: CustomDomain }>(this.cfg, {
      method: "POST",
      path: "/v1/custom-domains",
      json: { hostname },
      signal: opts.signal,
    });
    return response.data;
  }

  /** Re-check DNS and certificate state after records change. */
  async refresh(id: string, opts: { signal?: AbortSignal } = {}): Promise<CustomDomain> {
    const response = await request<{ data: CustomDomain }>(this.cfg, {
      method: "POST",
      path: `/v1/custom-domains/${encodeURIComponent(id)}/refresh`,
      signal: opts.signal,
    });
    return response.data;
  }

  /** Remove a custom domain. Canonical PixelVault URLs keep working. */
  async delete(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/custom-domains/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }
}
