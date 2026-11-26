import { request, type HttpConfig } from "./http.js";

export interface Project {
  id: string;
  name: string;
  strict_transforms: boolean;
  created_at: string;
  current?: boolean;
}

export interface CreatedProject extends Project {
  api_key?: string;
}

export interface ProjectListMeta {
  limit: number;
  total: number;
}

export interface UpdateProjectInput {
  name?: string;
  /** When true, rejects ad-hoc transform params on public URLs with 403. */
  strictTransforms?: boolean;
  signal?: AbortSignal;
}

export class ProjectsResource {
  constructor(private readonly cfg: HttpConfig) {}

  /** List projects on the account and plan capacity. */
  async list(opts: { signal?: AbortSignal } = {}): Promise<{
    data: Project[];
    meta: ProjectListMeta;
  }> {
    return request(this.cfg, {
      method: "GET",
      path: "/v1/projects",
      signal: opts.signal,
    });
  }

  /** Create a new project on the account. */
  async create(name: string, opts: { signal?: AbortSignal } = {}): Promise<CreatedProject> {
    const res = await request<{ data: CreatedProject }>(this.cfg, {
      method: "POST",
      path: "/v1/projects",
      json: { name },
      signal: opts.signal,
    });
    return res.data;
  }

  /** Rename a project or toggle `strictTransforms`. */
  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.strictTransforms !== undefined) body.strict_transforms = input.strictTransforms;
    const res = await request<{ data: Project }>(this.cfg, {
      method: "PATCH",
      path: `/v1/projects/${encodeURIComponent(id)}`,
      json: body,
      signal: input.signal,
    });
    return res.data;
  }

  /** Delete an empty project (an account must keep at least one project). */
  async delete(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await request(this.cfg, {
      method: "DELETE",
      path: `/v1/projects/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }
}
