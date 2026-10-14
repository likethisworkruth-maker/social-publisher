import { PLATFORMS, type AssetManifest, type Platform, type PlatformState, type ResolvedPost, type StoredPostState } from "./types.js";
import { SafeError } from "./utils.js";

export class StateStoreError extends SafeError {
  constructor(message: string) {
    super(message);
    this.name = "StateStoreError";
  }
}

const PLATFORM_STATUSES = new Set(["pending", "preparing", "ready", "publish_requested", "published", "retry_wait", "failed", "unknown"]);
const ERROR_CATEGORIES = new Set(["network", "rate_limit", "provider", "configuration", "input", "storage", "asset"]);
const POST_KEYS = new Set(["schemaVersion", "id", "inputHash", "contentHash", "sourceCommit", "updatedAt", "desiredPlatforms", "publishAt", "enabled", "platforms"]);
const PLATFORM_KEYS = new Set(["accountId", "apiVersion", "status", "attempts", "containerId", "childContainerIds", "containerStatus", "preparedAt", "preparationStartedAt", "nextAttemptAt", "publishRequestedAt", "publishRunId", "publishRunAttempt", "postId", "permalink", "publishedAt", "confirmedBy", "lastError", "recoveryHistory"]);

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function noUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new StateStoreError("Post state has unsupported " + label + " fields; automatic publishing is stopped.");
}

export function validateStoredPostState(value: unknown, expectedId?: string): StoredPostState {
  if (!object(value)) throw new StateStoreError("Post state is malformed; automatic publishing is stopped.");
  noUnknownKeys(value, POST_KEYS, "record");
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.id) || (expectedId && value.id !== expectedId)) {
    throw new StateStoreError("Post state identity or schema is malformed; automatic publishing is stopped.");
  }
  for (const key of ["inputHash", "contentHash"] as const) {
    if (typeof value[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value[key] as string)) throw new StateStoreError("Post state has an invalid " + key + "; automatic publishing is stopped.");
  }
  if (typeof value.sourceCommit !== "string" || !/^(?:local|[a-f0-9]{7,64})$/i.test(value.sourceCommit) ||
      !validDate(value.updatedAt) || !validDate(value.publishAt) || typeof value.enabled !== "boolean" ||
      !Array.isArray(value.desiredPlatforms) || value.desiredPlatforms.length === 0 ||
      value.desiredPlatforms.some((item) => !PLATFORMS.includes(item as Platform)) ||
      new Set(value.desiredPlatforms).size !== value.desiredPlatforms.length || !object(value.platforms)) {
    throw new StateStoreError("Post state metadata is malformed; automatic publishing is stopped.");
  }
  const desired = value.desiredPlatforms as Platform[];
  if (Object.keys(value.platforms).length !== desired.length || desired.some((platform) => !Object.hasOwn(value.platforms as object, platform))) {
    throw new StateStoreError("Post state platform records do not match desiredPlatforms; automatic publishing is stopped.");
  }
  for (const platform of desired) {
    const state = value.platforms[platform];
    if (!object(state)) throw new StateStoreError("Post state platform record is malformed; automatic publishing is stopped.");
    noUnknownKeys(state, PLATFORM_KEYS, "platform");
    if (typeof state.accountId !== "string" || state.accountId.length === 0 || state.accountId.length > 200 ||
        !PLATFORM_STATUSES.has(String(state.status)) || !Number.isInteger(state.attempts) || (state.attempts as number) < 0 ||
        (state.attempts as number) > 100 || !Array.isArray(state.childContainerIds) ||
        state.childContainerIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 300) ||
        new Set(state.childContainerIds as string[]).size !== state.childContainerIds.length || !Array.isArray(state.recoveryHistory)) {
      throw new StateStoreError("Post state " + platform + " status or checkpoint is malformed; automatic publishing is stopped.");
    }
    for (const key of ["containerId", "containerStatus", "apiVersion", "publishRunId", "postId", "permalink"] as const) {
      if (state[key] !== undefined && (typeof state[key] !== "string" || (state[key] as string).length === 0 || (state[key] as string).length > 2000)) {
        throw new StateStoreError("Post state " + platform + " has an invalid " + key + "; automatic publishing is stopped.");
      }
    }
    for (const key of ["preparedAt", "preparationStartedAt", "nextAttemptAt", "publishRequestedAt", "publishedAt"] as const) {
      if (state[key] !== undefined && !validDate(state[key])) throw new StateStoreError("Post state " + platform + " has an invalid " + key + "; automatic publishing is stopped.");
    }
    if (state.publishRunAttempt !== undefined && (!Number.isInteger(state.publishRunAttempt) || (state.publishRunAttempt as number) < 1)) {
      throw new StateStoreError("Post state " + platform + " has an invalid publish run attempt; automatic publishing is stopped.");
    }
    if (state.lastError !== undefined) {
      if (!object(state.lastError) || !ERROR_CATEGORIES.has(String(state.lastError.category)) || typeof state.lastError.stage !== "string" ||
          typeof state.lastError.message !== "string" || (state.lastError.httpStatus !== undefined && !Number.isInteger(state.lastError.httpStatus)) ||
          (state.lastError.providerCode !== undefined && typeof state.lastError.providerCode !== "string")) {
        throw new StateStoreError("Post state " + platform + " error record is malformed; automatic publishing is stopped.");
      }
    }
    if (state.recoveryHistory.some((entry) => !object(entry) || !validDate(entry.at) || typeof entry.runId !== "string" ||
        typeof entry.evidence !== "string" || entry.action !== "confirmed_not_published" ||
        (entry.previousAttempts !== undefined && (!Number.isInteger(entry.previousAttempts) || (entry.previousAttempts as number) < 0)) ||
        (entry.previousContainerId !== undefined && typeof entry.previousContainerId !== "string") ||
        (entry.previousChildContainerIds !== undefined && (!Array.isArray(entry.previousChildContainerIds) || entry.previousChildContainerIds.some((id) => typeof id !== "string"))))) {
      throw new StateStoreError("Post state " + platform + " recovery history is malformed; automatic publishing is stopped.");
    }
    if (state.status === "preparing" && ((state.attempts as number) < 1 || !state.apiVersion)) throw new StateStoreError("Post state preparation checkpoint is missing.");
    if (state.status === "ready" && (!state.containerId || !state.preparedAt || !state.apiVersion)) throw new StateStoreError("Ready post state is missing its container checkpoint.");
    if (state.status === "retry_wait" && (!state.nextAttemptAt || !state.lastError)) throw new StateStoreError("Retry-wait state is missing its retry checkpoint.");
    if (state.status === "failed" && !state.lastError) throw new StateStoreError("Failed state is missing its error record.");
    if (state.status === "failed" && (state.publishRequestedAt || state.publishRunId || state.publishRunAttempt || state.publishedAt || state.confirmedBy)) {
      throw new StateStoreError("Failed state contains a publish checkpoint and cannot be treated as definitely unpublished.");
    }
    if (state.status === "publish_requested" || state.status === "unknown") {
      if (!state.containerId || !state.preparedAt || !state.apiVersion || !state.publishRequestedAt || !state.publishRunId || !state.publishRunAttempt) {
        throw new StateStoreError("Ambiguous publish state is missing its mandatory request checkpoint.");
      }
    }
    if (state.status === "published") {
      if (!state.containerId || !state.preparedAt || !state.apiVersion || !state.publishRequestedAt || !state.publishRunId || !state.publishRunAttempt ||
          !state.publishedAt || (state.confirmedBy !== "publish_response" && state.confirmedBy !== "verified_container_status") ||
          (state.confirmedBy === "publish_response" && !state.postId)) {
        throw new StateStoreError("Published state is missing a valid confirmation record; automatic publishing is stopped.");
      }
    } else if (state.confirmedBy !== undefined) {
      throw new StateStoreError("Unpublished state contains a published confirmation; automatic publishing is stopped.");
    }
  }
  return value as unknown as StoredPostState;
}

export interface StateStore {
  listPostIds(): Promise<string[]>;
  getPost(id: string): Promise<StoredPostState | null>;
  ensurePost(post: ResolvedPost, initial: StoredPostState): Promise<StoredPostState>;
  mutatePost(id: string, update: (current: StoredPostState) => StoredPostState): Promise<StoredPostState>;
  getAssetManifest(id: string): Promise<AssetManifest | null>;
  listAssetManifests(): Promise<AssetManifest[]>;
  saveAssetManifest(manifest: AssetManifest): Promise<void>;
  initialize(): Promise<void>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function initialPlatformState(accountId: string): PlatformState {
  return { accountId, status: "pending", attempts: 0, childContainerIds: [], recoveryHistory: [] };
}

export function initialPostState(
  post: ResolvedPost,
  contentHash: string,
  accounts: Partial<Record<Platform, string>>,
  sourceCommit: string,
  now = new Date().toISOString()
): StoredPostState {
  const platforms: Partial<Record<Platform, PlatformState>> = {};
  for (const platform of post.platforms) {
    const accountId = accounts[platform];
    if (!accountId) throw new StateStoreError("A target account ID is missing; no posting request was made.");
    platforms[platform] = initialPlatformState(accountId);
  }
  return {
    schemaVersion: 1,
    id: post.id,
    inputHash: post.inputHash,
    contentHash,
    sourceCommit,
    updatedAt: now,
    desiredPlatforms: [...post.platforms],
    publishAt: post.publishAt,
    enabled: post.enabled,
    platforms
  };
}

export class MemoryStateStore implements StateStore {
  private readonly ids = new Set<string>();
  private readonly records = new Map<string, StoredPostState>();
  private readonly manifests = new Map<string, AssetManifest>();
  private initialized = true;
  failureHook?: (operation: string, id: string) => void;

  async listPostIds(): Promise<string[]> {
    if (!this.initialized) throw new StateStoreError("State store is not initialized.");
    return [...this.ids].sort();
  }

  async getPost(id: string): Promise<StoredPostState | null> {
    if (!this.initialized) throw new StateStoreError("State store is not initialized.");
    const listed = this.ids.has(id);
    const record = this.records.get(id);
    if (listed !== Boolean(record)) throw new StateStoreError("State registry and post records disagree; automatic publishing is stopped.");
    return record ? clone(validateStoredPostState(record, id)) : null;
  }

  async ensurePost(post: ResolvedPost, initial: StoredPostState): Promise<StoredPostState> {
    if (!this.initialized) throw new StateStoreError("State store is not initialized.");
    const listed = this.ids.has(post.id);
    const existing = this.records.get(post.id);
    if (listed && !existing) throw new StateStoreError("A registered post state file is missing; automatic publishing is stopped.");
    if (!listed && existing) throw new StateStoreError("A post state file exists without registry registration; automatic publishing is stopped.");
    if (existing) return clone(existing);
    validateStoredPostState(initial, post.id);
    this.failureHook?.("register", post.id);
    this.ids.add(post.id);
    this.failureHook?.("create-post", post.id);
    this.records.set(post.id, clone(initial));
    return clone(initial);
  }

  async mutatePost(id: string, update: (current: StoredPostState) => StoredPostState): Promise<StoredPostState> {
    const current = await this.getPost(id);
    if (!current) throw new StateStoreError("Post state is not registered.");
    this.failureHook?.("save-post", id);
    const next = update(clone(current));
    if (next.id !== id || next.schemaVersion !== 1) throw new StateStoreError("State update attempted to change the post identity.");
    validateStoredPostState(next, id);
    this.records.set(id, clone(next));
    return clone(next);
  }

  async getAssetManifest(id: string): Promise<AssetManifest | null> {
    if (!this.initialized) throw new StateStoreError("State store is not initialized.");
    const value = this.manifests.get(id);
    return value ? clone(value) : null;
  }

  async listAssetManifests(): Promise<AssetManifest[]> {
    if (!this.initialized) throw new StateStoreError("State store is not initialized.");
    return [...this.manifests.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id));
  }

  async saveAssetManifest(manifest: AssetManifest): Promise<void> {
    if (!this.initialized) throw new StateStoreError("State store is not initialized.");
    this.failureHook?.("save-assets", manifest.id);
    const existing = this.manifests.get(manifest.id);
    const currentUrls = new Set(manifest.assets.map((asset) => asset.url));
    const retained = new Map<string, AssetManifest["assets"][number]>();
    for (const asset of [...(existing?.retainedAssets ?? []), ...(existing?.assets ?? []), ...(manifest.retainedAssets ?? [])]) {
      if (!currentUrls.has(asset.url)) retained.set(asset.url, asset);
    }
    this.manifests.set(manifest.id, clone({ ...manifest, retainedAssets: [...retained.values()] }));
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  breakInitializationForTest(): void {
    this.initialized = false;
  }

  breakRegisteredStateForTest(id: string): void {
    this.ids.add(id);
    this.records.delete(id);
  }
}
