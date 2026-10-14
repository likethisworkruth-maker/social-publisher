import type {
  ContainerProgress, Platform, PlatformState, PreparedMedia, PublishOutcome, ReconcileOutcome, ResolvedPost, SanitizedError
} from "./types.js";
import { SafeError } from "./utils.js";

export class PlatformRequestError extends Error {
  constructor(readonly detail: SanitizedError, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(detail.message);
    this.name = "PlatformRequestError";
  }
}

export interface PlatformAdapter {
  readonly platform: Platform;
  validateConfiguration(accountId: string): void;
  checkPublishingQuota(accountId: string): Promise<PublishingQuota>;
  prepare(
    post: ResolvedPost,
    state: PlatformState,
    imageUrls: string[],
    checkpoint: (progress: ContainerProgress) => Promise<void>
  ): Promise<PreparedMedia>;
  publish(accountId: string, media: PreparedMedia, text: string): Promise<PublishOutcome>;
  reconcile(state: PlatformState): Promise<ReconcileOutcome>;
}

export interface PublishingQuota {
  usage: number;
  total: number;
  durationSeconds: number;
}

interface GraphConfig {
  platform: Platform;
  host: string;
  token?: string;
  apiVersion?: string;
}

interface ProviderEnvelope {
  data?: unknown;
  id?: unknown;
  permalink?: unknown;
  status?: unknown;
  status_code?: unknown;
  error?: { code?: unknown };
}

class GraphClient {
  private readonly base: string;
  constructor(private readonly config: GraphConfig) {
    if (!config.apiVersion || !/^v?\d{1,3}\.\d+$/.test(config.apiVersion)) {
      throw new SafeError(config.platform.toUpperCase() + "_API_VERSION must be explicitly set as vNN.N.");
    }
    this.base = "https://" + config.host + "/" + (config.apiVersion.startsWith("v") ? config.apiVersion : "v" + config.apiVersion);
  }

  async request(stage: string, method: "GET" | "POST", path: string, values?: Record<string, string>): Promise<ProviderEnvelope> {
    const url = new URL(this.base + path);
    const init: RequestInit = {
      method,
      headers: { Authorization: "Bearer " + (this.config.token ?? ""), Accept: "application/json" },
      signal: AbortSignal.timeout(30_000)
    };
    if (method === "GET" && values) {
      for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    } else if (method === "POST" && values) {
      init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
      init.body = new URLSearchParams(values).toString();
    }
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new PlatformRequestError({
        category: "network",
        stage,
        message: "SNS request did not return a response."
      }, stage !== "publish");
    }
    let body: ProviderEnvelope = {};
    try {
      const decoded: unknown = await response.json();
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid provider envelope.");
      body = decoded as ProviderEnvelope;
    } catch {
      if (stage === "publish") {
        throw new PlatformRequestError({ category: "network", stage, httpStatus: response.status, message: "Publish response could not be interpreted." }, false);
      }
    }
    if (!response.ok) {
      const rawCode = body.error?.code;
      const providerCode = typeof rawCode === "number" || typeof rawCode === "string" ? String(rawCode).slice(0, 48) : undefined;
      const retryable = (response.status === 429 || response.status >= 500) && stage !== "publish";
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
      throw new PlatformRequestError({
        category: response.status === 429 ? "rate_limit" : "provider",
        stage,
        httpStatus: response.status,
        ...(providerCode ? { providerCode } : {}),
        message: "SNS returned an error; provider details were withheld."
      }, retryable, retryAfterMs);
    }
    return body;
  }
}

abstract class MetaImageAdapter implements PlatformAdapter {
  abstract readonly platform: Platform;
  protected abstract readonly endpoint: (accountId: string) => string;
  protected abstract readonly host: string;
  protected abstract readonly quotaEdge: string;

  constructor(
    private readonly token: string | undefined,
    private readonly apiVersion: string | undefined
  ) {}

  validateConfiguration(accountId: string): void {
    if (!this.token || !accountId || !this.apiVersion) {
      throw new SafeError(this.platform.toUpperCase() + " token, account ID, and API version are required.");
    }
    if (!/^v?\d{1,3}\.\d+$/.test(this.apiVersion)) {
      throw new SafeError(this.platform.toUpperCase() + "_API_VERSION must be explicitly set as vNN.N.");
    }
  }

  protected client(): GraphClient {
    if (!this.token) throw new SafeError(this.platform.toUpperCase() + " access token is missing.");
    return new GraphClient({ platform: this.platform, host: this.host, token: this.token, apiVersion: this.apiVersion });
  }

  protected abstract childValues(url: string): Record<string, string>;
  protected abstract singleValues(url: string, text: string): Record<string, string>;
  protected abstract carouselValues(children: string[], text: string): Record<string, string>;
  protected abstract publishPath(accountId: string): string;
  protected abstract publishValues(containerId: string): Record<string, string>;
  protected abstract statusFields(): string;
  protected abstract readStatus(body: ProviderEnvelope): string;

  async checkPublishingQuota(accountId: string): Promise<PublishingQuota> {
    this.validateConfiguration(accountId);
    const body = await this.client().request("publishing_quota", "GET",
      "/" + encodeURIComponent(accountId) + "/" + this.quotaEdge, { fields: "quota_usage,config" });
    const entry = Array.isArray(body.data) && body.data.length === 1 ? body.data[0] : undefined;
    const config = entry && typeof entry === "object" ? entry.config : undefined;
    const usage = entry?.quota_usage;
    const total = config?.quota_total;
    const durationSeconds = config?.quota_duration;
    if (!Number.isSafeInteger(usage) || usage < 0 || !Number.isSafeInteger(total) || total < 0 ||
        !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
      throw new PlatformRequestError({ category: "provider", stage: "publishing_quota",
        message: "Publishing quota could not be verified; no publication was attempted." }, true);
    }
    return { usage, total, durationSeconds };
  }

  async prepare(
    post: ResolvedPost,
    state: PlatformState,
    imageUrls: string[],
    checkpoint: (progress: ContainerProgress) => Promise<void>
  ): Promise<PreparedMedia> {
    this.validateConfiguration(state.accountId);
    if (imageUrls.length !== post.resolvedImages.length || imageUrls.length === 0) throw new SafeError("Public image URLs do not match the post.");
    const client = this.client();
    const pathForAccount = this.endpoint(state.accountId);
    let containerId = state.containerId;
    let childIds = [...state.childContainerIds];

    if (imageUrls.length === 1) {
      if (!containerId) {
        const created = await client.request("create_container", "POST", pathForAccount, this.singleValues(imageUrls[0]!, post.platformTexts[this.platform] ?? ""));
        if (typeof created.id !== "string" || !created.id) throw new PlatformRequestError({
          category: "provider", stage: "create_container", message: "SNS did not return a container ID."
        }, true);
        containerId = created.id;
        await checkpoint({ containerId, childContainerIds: [], apiVersion: this.apiVersion });
      }
    } else {
      for (let index = childIds.length; index < imageUrls.length; index += 1) {
        const created = await client.request("create_child_container", "POST", pathForAccount, this.childValues(imageUrls[index]!));
        if (typeof created.id !== "string" || !created.id) throw new PlatformRequestError({
          category: "provider", stage: "create_child_container", message: "SNS did not return a child container ID."
        }, true);
        childIds.push(created.id);
        await checkpoint({ childContainerIds: [...childIds], apiVersion: this.apiVersion });
      }
      if (!containerId) {
        const created = await client.request("create_carousel_container", "POST", pathForAccount,
          this.carouselValues(childIds, post.platformTexts[this.platform] ?? ""));
        if (typeof created.id !== "string" || !created.id) throw new PlatformRequestError({
          category: "provider", stage: "create_carousel_container", message: "SNS did not return a parent container ID."
        }, true);
        containerId = created.id;
        await checkpoint({ containerId, childContainerIds: [...childIds], apiVersion: this.apiVersion });
      }
    }

    const statusBody = await client.request("container_status", "GET", "/" + encodeURIComponent(containerId), { fields: this.statusFields() });
    const status = this.readStatus(statusBody);
    return { containerId, childContainerIds: childIds, ready: status === "FINISHED", status };
  }

  async publish(accountId: string, media: PreparedMedia, _text: string): Promise<PublishOutcome> {
    const client = this.client();
    try {
      const body = await client.request("publish", "POST", this.publishPath(accountId), this.publishValues(media.containerId));
      if (typeof body.id !== "string" || !body.id) {
        return {
          kind: "unknown",
          error: { category: "network", stage: "publish", message: "Publish response did not prove a published media ID." }
        };
      }
      const permalink = typeof body.permalink === "string" && /^https:\/\//.test(body.permalink) ? body.permalink : undefined;
      return { kind: "published", postId: body.id, ...(permalink ? { permalink } : {}) };
    } catch (error) {
      const detail = error instanceof PlatformRequestError ? error.detail : {
        category: "network" as const,
        stage: "publish",
        message: "Publish response was not confirmed."
      };
      return { kind: "unknown", error: detail };
    }
  }

  async reconcile(state: PlatformState): Promise<ReconcileOutcome> {
    if (!state.containerId || !state.apiVersion || state.apiVersion !== this.apiVersion) {
      return { kind: "unknown", detail: "The saved container or matching API version is unavailable for read-only reconciliation." };
    }
    try {
      const body = await this.client().request("reconcile_container_status", "GET", "/" + encodeURIComponent(state.containerId), {
        fields: this.reconcileStatusFields()
      });
      const status = this.readStatus(body);
      if (body.id !== state.containerId || status !== "PUBLISHED") {
        return { kind: "unknown", detail: "The saved container was not directly confirmed as PUBLISHED." };
      }
      return { kind: "published", confirmedBy: "verified_container_status" };
    } catch {
      return { kind: "unknown", detail: "Read-only container reconciliation did not confirm PUBLISHED." };
    }
  }

  protected reconcileStatusFields(): string { return this.statusFields(); }
}

export class InstagramAdapter extends MetaImageAdapter {
  readonly platform = "instagram" as const;
  protected readonly host = "graph.instagram.com";
  protected readonly quotaEdge = "content_publishing_limit";
  protected readonly endpoint = (accountId: string): string => "/" + encodeURIComponent(accountId) + "/media";

  protected childValues(url: string): Record<string, string> {
    return { media_type: "IMAGE", image_url: url, is_carousel_item: "true" };
  }
  protected singleValues(url: string, text: string): Record<string, string> {
    return { image_url: url, caption: text };
  }
  protected carouselValues(children: string[], text: string): Record<string, string> {
    return { media_type: "CAROUSEL", children: children.join(","), caption: text };
  }
  protected publishPath(accountId: string): string {
    return "/" + encodeURIComponent(accountId) + "/media_publish";
  }
  protected publishValues(containerId: string): Record<string, string> {
    return { creation_id: containerId };
  }
  protected statusFields(): string {
    return "id,status_code,status";
  }
  protected readStatus(body: ProviderEnvelope): string {
    const value = typeof body.status_code === "string" ? body.status_code : "";
    return /^[A-Z_]{1,32}$/.test(value) ? value : "UNRECOGNIZED";
  }
}

export class ThreadsAdapter extends MetaImageAdapter {
  readonly platform = "threads" as const;
  protected readonly host = "graph.threads.net";
  protected readonly quotaEdge = "threads_publishing_limit";
  protected readonly endpoint = (accountId: string): string => "/" + encodeURIComponent(accountId) + "/threads";

  protected childValues(url: string): Record<string, string> {
    return { media_type: "IMAGE", image_url: url, is_carousel_item: "true" };
  }
  protected singleValues(url: string, text: string): Record<string, string> {
    return { media_type: "IMAGE", image_url: url, text };
  }
  protected carouselValues(children: string[], text: string): Record<string, string> {
    return { media_type: "CAROUSEL", children: children.join(","), text };
  }
  protected publishPath(accountId: string): string {
    return "/" + encodeURIComponent(accountId) + "/threads_publish";
  }
  protected publishValues(containerId: string): Record<string, string> {
    return { creation_id: containerId };
  }
  protected statusFields(): string {
    return "id,status,error_message";
  }
  protected readStatus(body: ProviderEnvelope): string {
    const value = typeof body.status === "string" ? body.status : "";
    return /^[A-Z_]{1,32}$/.test(value) ? value : "UNRECOGNIZED";
  }
}

export function createAdapters(env: NodeJS.ProcessEnv = process.env): Record<Platform, PlatformAdapter> {
  return {
    instagram: new InstagramAdapter(env.INSTAGRAM_ACCESS_TOKEN, env.INSTAGRAM_API_VERSION),
    threads: new ThreadsAdapter(env.THREADS_ACCESS_TOKEN, env.THREADS_API_VERSION)
  };
}
