export const PLATFORMS = ["instagram", "threads"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type PlatformStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "publish_requested"
  | "published"
  | "retry_wait"
  | "failed"
  | "unknown";

export type ConfirmationSource = "publish_response" | "verified_container_status";

export interface PostInput {
  schemaVersion: 1;
  id: string;
  enabled: boolean;
  publishAt: string;
  text: string;
  images: string[];
  platforms: Platform[];
  overrides: Partial<Record<Platform, { text: string }>>;
}

export interface ResolvedImage {
  name: string;
  path: string;
  sha256: string;
  size: number;
  width: number;
  height: number;
}

export interface ResolvedPost extends PostInput {
  directory: string;
  publishAtMs: number;
  inputHash: string;
  platformTexts: Record<Platform, string | undefined>;
  resolvedImages: ResolvedImage[];
}

export interface SanitizedError {
  category: "network" | "rate_limit" | "provider" | "configuration" | "input" | "storage" | "asset";
  stage: string;
  httpStatus?: number;
  providerCode?: string;
  message: string;
}

export interface RecoveryEntry {
  at: string;
  runId: string;
  evidence: string;
  previousAttempts?: number;
  previousContainerId?: string;
  previousChildContainerIds?: string[];
  action: "confirmed_not_published";
}

export interface PlatformState {
  accountId: string;
  apiVersion?: string;
  status: PlatformStatus;
  attempts: number;
  containerId?: string;
  childContainerIds: string[];
  containerStatus?: string;
  preparedAt?: string;
  preparationStartedAt?: string;
  nextAttemptAt?: string;
  publishRequestedAt?: string;
  publishRunId?: string;
  publishRunAttempt?: number;
  postId?: string;
  permalink?: string;
  publishedAt?: string;
  confirmedBy?: ConfirmationSource;
  lastError?: SanitizedError;
  recoveryHistory: RecoveryEntry[];
}

export interface StoredPostState {
  schemaVersion: 1;
  id: string;
  inputHash: string;
  contentHash: string;
  sourceCommit: string;
  updatedAt: string;
  desiredPlatforms: Platform[];
  publishAt: string;
  enabled: boolean;
  platforms: Partial<Record<Platform, PlatformState>>;
}

export interface AssetManifestEntry {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface AssetManifest {
  schemaVersion: 1;
  id: string;
  inputHash: string;
  sourceCommit: string;
  deploymentId: string;
  createdAt: string;
  baseUrl: string;
  assets: AssetManifestEntry[];
  retainedAssets?: AssetManifestEntry[];
}

export interface ContainerProgress {
  containerId?: string;
  childContainerIds?: string[];
  containerStatus?: string;
  apiVersion?: string;
}

export interface PreparedMedia {
  containerId: string;
  childContainerIds: string[];
  ready: boolean;
  status?: string;
}

export type PublishOutcome =
  | { kind: "published"; postId: string; permalink?: string }
  | { kind: "unknown"; error: SanitizedError };

export type ReconcileOutcome =
  | { kind: "published"; postId?: string; permalink?: string; confirmedBy: ConfirmationSource }
  | { kind: "unknown"; detail: string };
