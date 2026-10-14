import type {
  Platform, PlatformState, ResolvedPost, StoredPostState
} from "./types.js";
import type { StateStore } from "./state.js";
import { initialPostState } from "./state.js";
import type { PlatformAdapter } from "./platforms.js";
import { PlatformRequestError } from "./platforms.js";
import { AssetUnavailableError, resolveAndVerifyAssets, type VerifiedAssets } from "./assets.js";
import { StateStoreError } from "./state.js";
import { SafeError, computeContentHash, getRunAttempt, getRunId, getSourceCommit, logEvent, validateRecoveryEvidence } from "./utils.js";

export type RunnerAction = "publish" | "dry-run" | "reconcile" | "recover" | "retry-failed";

export interface RecoveryRequest {
  platform: Platform;
  evidence: string;
}

export interface PublisherRequest {
  action: RunnerAction;
  posts: ResolvedPost[];
  inputErrors?: string[];
  postId?: string;
  now?: boolean;
  recovery?: RecoveryRequest;
  maxLatenessMinutes?: number;
  maxPostsPerRun?: number;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ReportRow {
  postId: string;
  platform: Platform;
  status: string;
  detail?: string;
}

export interface RunReport {
  rows: ReportRow[];
  inputErrors: string[];
  failed: boolean;
}

export interface PublisherDependencies {
  store: StateStore;
  adapters: Record<Platform, PlatformAdapter>;
  assets?: (post: ResolvedPost, store: StateStore, env: NodeJS.ProcessEnv) => Promise<VerifiedAssets>;
  now?: () => number;
  random?: () => number;
}

function latestError(category: "provider" | "network" | "input" | "asset", stage: string, message: string) {
  return { category, stage, message } as const;
}

function withTimestamp(state: StoredPostState, now: number): StoredPostState {
  return { ...state, updatedAt: new Date(now).toISOString() };
}

function clonePlatform(platformState: PlatformState): PlatformState {
  return JSON.parse(JSON.stringify(platformState)) as PlatformState;
}

function removeKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function retryDelayMs(attempts: number, retryAfterMs?: number, random = Math.random): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
  const jitter = Math.floor(random() * Math.min(base * 0.2, 30_000));
  return Math.max(base + jitter, retryAfterMs ?? 0);
}

export class Publisher {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly assetResolver: (post: ResolvedPost, store: StateStore, env: NodeJS.ProcessEnv) => Promise<VerifiedAssets>;

  constructor(private readonly dependencies: PublisherDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.assetResolver = dependencies.assets ?? resolveAndVerifyAssets;
  }

  async run(request: PublisherRequest): Promise<RunReport> {
    const now = request.nowMs ?? this.now();
    const env = request.env ?? process.env;
    const rows: ReportRow[] = [];
    const inputErrors = [...(request.inputErrors ?? [])];
    if (request.now && (!request.postId || request.action !== "publish")) {
      throw new SafeError("--now requires one explicit post ID in a publish workflow.");
    }
    const maxPosts = request.maxPostsPerRun ?? Number(env.MAX_POSTS_PER_RUN ?? "10");
    if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 100) {
      throw new SafeError("MAX_POSTS_PER_RUN must be an integer between 1 and 100.");
    }
    if (request.action === "recover") return this.recover(request, rows, inputErrors, now);
    if (request.action === "retry-failed") return this.retryFailed(request, rows, inputErrors, now);
    const ids = await this.dependencies.store.listPostIds();

    if (request.action === "dry-run") {
      const selected = (request.postId ? request.posts.filter((post) => post.id === request.postId) : request.posts)
        .sort((a, b) => a.publishAtMs - b.publishAtMs || a.id.localeCompare(b.id));
      let selectedForWork = 0;
      for (const post of selected) {
        const state = ids.includes(post.id) ? await this.dependencies.store.getPost(post.id) : null;
        const previewHash = computeContentHash(post, this.accountIds(post, env, state ?? undefined));
        const contentMatches = !state || (state.contentHash === previewHash && state.inputHash === post.inputHash);
        const editableBeforePreparation = Boolean(state && !contentMatches && this.canChangeBeforePreparation(state));
        const due = request.now === true || post.publishAtMs <= now;
        const needsWork = this.hasActionableWork(post, state, previewHash, due, request.now === true, now);
        let deferredByLimit = false;
        if (post.enabled && needsWork) {
          if (selectedForWork >= maxPosts) deferredByLimit = true;
          else selectedForWork += 1;
        }
        if (state && !contentMatches && !editableBeforePreparation && post.enabled) {
          for (const platform of post.platforms) rows.push({ postId: post.id, platform, status: "content_changed" });
          continue;
        }
        for (const platform of post.platforms) {
          const platformState = state?.platforms[platform];
          const current = editableBeforePreparation ? undefined : platformState;
          const text = post.platformTexts[platform] ?? "";
          console.log("dry_run post_id=" + post.id + " platform=" + platform + " text_utf16=" + text.length +
            " publish_at_utc=" + new Date(post.publishAtMs).toISOString());
          console.log(text);
          if (deferredByLimit) {
            rows.push({ postId: post.id, platform, status: "deferred_limit", detail: "MAX_POSTS_PER_RUN" });
            continue;
          }
          const maxLate = request.maxLatenessMinutes ?? Number(env.MAX_LATENESS_MINUTES ?? "1440");
          const late = now - post.publishAtMs > maxLate * 60_000;
          let previewStatus: string;
          let detail: string | undefined;
          if (!Number.isFinite(maxLate) || maxLate < 0) {
            previewStatus = "invalid_schedule_limit";
            detail = "MAX_LATENESS_MINUTES must be a non-negative number";
          } else if (current?.status === "published") previewStatus = "skip_published";
          else if (current?.status === "unknown" || current?.status === "publish_requested") previewStatus = "reconcile_only";
          else if (!post.enabled) previewStatus = "skip_disabled";
          else if (current?.status === "failed") {
            previewStatus = current.lastError?.stage === "schedule_late" ? "requires_now" : "failed";
            detail = current.lastError?.stage;
          } else if (!due) previewStatus = "wait_until_due";
          else if (late) {
            previewStatus = "requires_now";
            detail = "schedule_late";
          } else if (current?.status === "ready" && current.nextAttemptAt && Date.parse(current.nextAttemptAt) > now) {
            previewStatus = "retry_wait";
            detail = "next_attempt_not_due:" + current.nextAttemptAt;
          } else if (current?.status === "retry_wait") {
            const retryAt = current.nextAttemptAt ? Date.parse(current.nextAttemptAt) : 0;
            if (Number.isFinite(retryAt) && retryAt > now) {
              previewStatus = "retry_wait";
              detail = "next_attempt_not_due:" + current.nextAttemptAt;
            } else if (current.attempts >= 5) {
              previewStatus = "failed";
              detail = "attempt_limit";
            } else {
              previewStatus = "would_retry_preparation";
            }
          } else if (current?.status === "pending" && current.attempts >= 5) {
            previewStatus = "failed";
            detail = "attempt_limit";
          } else if (current?.status === "preparing") previewStatus = "would_resume_preparation";
          else if (current?.status === "ready") previewStatus = "would_publish";
          else previewStatus = "would_prepare";
          if (editableBeforePreparation && !detail) detail = "content can still be updated before SNS preparation";
          else if (state && !contentMatches && !detail) detail = "content differs from frozen state; post is disabled";
          rows.push({
            postId: post.id,
            platform,
            status: previewStatus,
            detail: detail ?? "local Dry Run; durable state and public URL were not changed or checked"
          });
        }
      }
      if (request.postId && selected.length === 0) rows.push({ postId: request.postId, platform: "instagram", status: "not_found" });
      return { rows, inputErrors, failed: inputErrors.length > 0 || rows.some((row) => row.status === "invalid_schedule_limit") };
    }

    await this.reconcileOutstanding(ids, request.posts, request.action, request.postId, rows, now);
    if (request.action === "reconcile") {
      return { rows, inputErrors, failed: inputErrors.length > 0 || rows.some((row) => row.status === "unknown") };
    }
    if (request.action !== "publish") throw new SafeError("Unsupported publisher action.");

    const eligible = request.posts.filter((post) => !request.postId || post.id === request.postId)
      .sort((a, b) => a.publishAtMs - b.publishAtMs || a.id.localeCompare(b.id));
    if (request.postId && eligible.length === 0) {
      const existing = ids.includes(request.postId) ? await this.dependencies.store.getPost(request.postId) : null;
      if (!existing) rows.push({ postId: request.postId, platform: "instagram", status: "not_found" });
    }
    let selectedForWork = 0;
    for (const post of eligible) {
      const previous = ids.includes(post.id) ? await this.dependencies.store.getPost(post.id) : null;
      const currentHash = computeContentHash(post, this.accountIds(post, env, previous ?? undefined));
      const due = request.now === true || post.publishAtMs <= now;
      const needsWork = this.hasActionableWork(post, previous, currentHash, due, request.now === true, now);
      if (post.enabled && needsWork) {
        if (selectedForWork >= maxPosts) {
          for (const platform of post.platforms) rows.push({ postId: post.id, platform, status: "deferred_limit" });
          continue;
        }
        selectedForWork += 1;
      }
      if (!post.enabled) {
        const saved = await this.dependencies.store.getPost(post.id);
        if (saved) await this.updatePost(post.id, (current) => withTimestamp({ ...current, enabled: false }, now), now);
        for (const platform of post.platforms) rows.push({ postId: post.id, platform, status: "skip_disabled" });
        continue;
      }
      await this.processPost(post, request, rows, now, env);
    }
    const failed = inputErrors.length > 0 || rows.some((row) => ["unknown", "failed", "retry_wait", "content_changed", "not_found"].includes(row.status));
    return { rows, inputErrors, failed };
  }

  private canChangeBeforePreparation(state: StoredPostState): boolean {
    return state.desiredPlatforms.every((platform) => {
      const current = state.platforms[platform];
      return Boolean(current && (current.status === "pending" || current.status === "retry_wait") &&
        current.attempts === 0 && !current.containerId && current.childContainerIds.length === 0 &&
        !current.preparationStartedAt && !current.preparedAt && !current.apiVersion && current.recoveryHistory.length === 0 &&
        !current.publishRequestedAt && !current.publishedAt && !current.confirmedBy);
    });
  }

  private hasActionableWork(post: ResolvedPost, state: StoredPostState | null, contentHash: string, due: boolean, nowOverride: boolean, now: number): boolean {
    if (!post.enabled || !due) return false;
    if (!state) return true;
    if (state.contentHash !== contentHash || state.inputHash !== post.inputHash) return this.canChangeBeforePreparation(state);
    return post.platforms.some((platform) => {
      const current = state.platforms[platform];
      if (!current) return true;
      if (current.status === "ready") return !current.nextAttemptAt || Date.parse(current.nextAttemptAt) <= now;
      if (current.status === "pending" || current.status === "preparing") return true;
      if (current.status === "retry_wait") return !current.nextAttemptAt || Date.parse(current.nextAttemptAt) <= now;
      return nowOverride && current.status === "failed" && current.lastError?.stage === "schedule_late";
    });
  }

  private accountIds(post: ResolvedPost, env: NodeJS.ProcessEnv, saved?: StoredPostState): Record<Platform, string | undefined> {
    return {
      instagram: post.platforms.includes("instagram") ? (env.INSTAGRAM_ACCOUNT_ID ?? saved?.platforms.instagram?.accountId) : undefined,
      threads: post.platforms.includes("threads") ? (env.THREADS_USER_ID ?? saved?.platforms.threads?.accountId) : undefined
    };
  }

  private async processPost(post: ResolvedPost, request: PublisherRequest, rows: ReportRow[], now: number, env: NodeJS.ProcessEnv): Promise<void> {
    const due = request.now === true || post.publishAtMs <= now;
    const existing = await this.dependencies.store.getPost(post.id);
    if (!existing && !due) {
      for (const platform of post.platforms) rows.push({ postId: post.id, platform, status: "wait_until_due" });
      return;
    }
    const accountIds = this.accountIds(post, env, existing ?? undefined);
    const contentHash = computeContentHash(post, accountIds);
    const initial = initialPostState(post, contentHash, accountIds, getSourceCommit(), new Date(now).toISOString());
    let state: StoredPostState;
    if (!existing) {
      state = await this.dependencies.store.ensurePost(post, initial);
    } else if (existing.contentHash !== contentHash || existing.inputHash !== post.inputHash) {
      if (!this.canChangeBeforePreparation(existing)) {
        logEvent({ postId: post.id, stage: "input_check", status: "content_changed" });
        for (const platform of post.platforms) rows.push({ postId: post.id, platform, status: "content_changed" });
        return;
      }
      state = await this.updatePost(post.id, (current) => ({
        ...current,
        inputHash: initial.inputHash,
        contentHash: initial.contentHash,
        sourceCommit: initial.sourceCommit,
        desiredPlatforms: initial.desiredPlatforms,
        platforms: initial.platforms
      }), now);
    } else {
      state = existing;
    }

    if (state.enabled !== post.enabled || state.publishAt !== post.publishAt) {
      state = await this.updatePost(post.id, (current) => withTimestamp({
        ...current,
        enabled: post.enabled,
        publishAt: post.publishAt
      }, now), now);
    }

    if (post.publishAtMs > now && !request.now) {
      for (const platform of post.platforms) {
        const platformState = state.platforms[platform]!;
        const status = platformState.status === "published" ? "skip_published" :
          platformState.status === "unknown" || platformState.status === "publish_requested" ? "reconcile_only" :
            platformState.status === "failed" ? "failed" : "wait_until_due";
        rows.push({ postId: post.id, platform, status });
      }
      return;
    }

    const activePlatforms = post.platforms.filter((platform) => {
      const current = state.platforms[platform];
      const explicitLateOverride = request.now && current?.status === "failed" && current.lastError?.stage === "schedule_late";
      return current && current.status !== "published" && current.status !== "unknown" &&
        current.status !== "publish_requested" && (current.status !== "failed" || explicitLateOverride);
    });

    const maxLate = request.maxLatenessMinutes ?? Number(env.MAX_LATENESS_MINUTES ?? "1440");
    if (!Number.isFinite(maxLate) || maxLate < 0) throw new SafeError("MAX_LATENESS_MINUTES must be a non-negative number.");
    if (!request.now && now - post.publishAtMs > maxLate * 60_000) {
      for (const platform of post.platforms) {
        const current = state.platforms[platform]!;
        if (current.status === "pending" || current.status === "retry_wait" || current.status === "preparing" || current.status === "ready") {
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            status: "failed",
            lastError: latestError("provider", "schedule_late", "Post is outside the automatic lateness window; explicit --now is required.")
          }), now);
        }
        rows.push({ postId: post.id, platform, status: current.status === "published" ? "skip_published" :
          current.status === "unknown" || current.status === "publish_requested" ? "reconcile_only" : "failed", detail: "schedule_late" });
      }
      return;
    }

    if (activePlatforms.length === 0) {
      for (const platform of post.platforms) {
        const current = state.platforms[platform]!;
        rows.push({ postId: post.id, platform, status: current.status === "published" ? "skip_published" :
          current.status === "unknown" || current.status === "publish_requested" ? "reconcile_only" : current.status });
      }
      return;
    }

    const workPlatforms = activePlatforms.filter((platform) => {
      const current = state.platforms[platform]!;
      if (current.status !== "retry_wait" && current.status !== "ready") return true;
      const next = current.nextAttemptAt ? Date.parse(current.nextAttemptAt) : 0;
      return !Number.isFinite(next) || next <= now;
    });
    for (const platform of activePlatforms.filter((item) => !workPlatforms.includes(item))) {
      rows.push({ postId: post.id, platform, status: "retry_wait", detail: "next_attempt_not_due" });
    }
    if (workPlatforms.length === 0) return;

    for (const platform of workPlatforms) {
      this.dependencies.adapters[platform].validateConfiguration(accountIds[platform] ?? "");
      const expiryName = platform === "instagram" ? "INSTAGRAM_TOKEN_EXPIRES_AT" : "THREADS_TOKEN_EXPIRES_AT";
      const expiry = env[expiryName];
      if (!expiry || !Number.isFinite(Date.parse(expiry))) throw new SafeError(expiryName + " is required before publishing.");
      if (Date.parse(expiry) <= now) throw new SafeError(platform.toUpperCase() + " token expiry metadata is past.");
      if (Date.parse(expiry) - now <= 7 * 24 * 60 * 60_000) {
        console.warn("token_expiry_warning platform=" + platform + " expires_within_days=7");
      }
    }

    let verified: VerifiedAssets;
    try {
      verified = await this.assetResolver(post, this.dependencies.store, env);
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      const unavailable = error instanceof AssetUnavailableError;
      const retryAt = new Date(now + retryDelayMs(1, undefined, this.random)).toISOString();
      for (const platform of workPlatforms) {
        await this.updatePlatform(post.id, platform, (previous) => ({
          ...previous,
          status: unavailable ? "retry_wait" : "failed",
          ...(unavailable ? { nextAttemptAt: retryAt } : {}),
          lastError: latestError(unavailable ? "asset" : "input", unavailable ? "asset_delivery_wait" : "asset_verification",
            error instanceof SafeError ? error.message : "Public image verification failed.")
        }), now);
        rows.push({ postId: post.id, platform, status: unavailable ? "retry_wait" : "failed", detail: unavailable ? "asset_not_ready" : "asset_verification" });
      }
      return;
    }

    for (const platform of post.platforms) {
      state = (await this.dependencies.store.getPost(post.id))!;
      const current = state.platforms[platform];
      if (!current) throw new SafeError("Stored platform state is missing.");
      if (current.status === "published") {
        rows.push({ postId: post.id, platform, status: "skip_published" });
        continue;
      }
      if (current.status === "unknown" || current.status === "publish_requested") {
        rows.push({ postId: post.id, platform, status: "reconcile_only" });
        continue;
      }
      if (current.status === "failed") {
        if (request.now && current.lastError?.stage === "schedule_late") {
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            status: "pending",
            lastError: undefined,
            nextAttemptAt: undefined
          }), now);
        } else {
          rows.push({ postId: post.id, platform, status: "failed" });
          continue;
        }
      }
      const readyState = await this.dependencies.store.getPost(post.id);
      const readyPlatform = readyState?.platforms[platform];
      if (!readyPlatform) throw new SafeError("Stored platform state is missing.");

      if (readyPlatform.status === "retry_wait" || readyPlatform.status === "ready") {
        const next = readyPlatform.nextAttemptAt ? Date.parse(readyPlatform.nextAttemptAt) : 0;
        if (Number.isFinite(next) && next > now) {
          rows.push({ postId: post.id, platform, status: "retry_wait", detail: "next_attempt_not_due" });
          continue;
        }
      }
      if (!readyPlatform.preparationStartedAt && !readyPlatform.containerId &&
          !await this.quotaAllowsPublication(post.id, platform, readyPlatform.accountId, rows, now)) continue;
      if (readyPlatform.status === "pending" || readyPlatform.status === "retry_wait") {
        if (readyPlatform.attempts >= 5) {
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            status: "failed",
            lastError: latestError("provider", "attempt_limit", "Safe preparation retry limit reached.")
          }), now);
          rows.push({ postId: post.id, platform, status: "failed", detail: "attempt_limit" });
          continue;
        }
        await this.updatePlatform(post.id, platform, (previous) => ({
          ...previous,
          status: "preparing",
          attempts: previous.attempts + 1,
          preparationStartedAt: previous.preparationStartedAt ?? new Date(now).toISOString(),
          nextAttemptAt: undefined,
          lastError: undefined,
          apiVersion: env[platform === "instagram" ? "INSTAGRAM_API_VERSION" : "THREADS_API_VERSION"]
        }), now);
      }

      let prepared;
      try {
        const beforePrepare = (await this.dependencies.store.getPost(post.id))!.platforms[platform]!;
        prepared = await this.dependencies.adapters[platform].prepare(post, beforePrepare, verified.urls, async (progress) => {
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            ...progress,
            status: "preparing"
          }), now);
        });
      } catch (error) {
        if (error instanceof PlatformRequestError) {
          const canRetry = error.retryable && readyPlatform.attempts < 5;
          const delay = retryDelayMs(Math.max(1, readyPlatform.attempts), error.retryAfterMs, this.random);
          const retryAt = new Date(now + delay).toISOString();
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            status: canRetry ? "retry_wait" : "failed",
            ...(canRetry ? { nextAttemptAt: retryAt } : {}),
            lastError: error.detail
          }), now);
          rows.push({ postId: post.id, platform, status: canRetry ? "retry_wait" : "failed", detail: error.detail.stage });
        } else {
          throw error;
        }
        continue;
      }

      if (!prepared.ready) {
        if (prepared.status === "ERROR" || prepared.status === "EXPIRED") {
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            status: "failed",
            containerStatus: prepared.status,
            lastError: latestError("provider", "container_status", "Container preparation did not finish; no publish request was made.")
          }), now);
          rows.push({ postId: post.id, platform, status: "failed", detail: "container_not_ready" });
        } else {
          await this.updatePlatform(post.id, platform, (previous) => ({
            ...previous,
            status: "preparing",
            containerStatus: prepared.status
          }), now);
          rows.push({ postId: post.id, platform, status: "preparing", detail: prepared.status ?? "status_unconfirmed" });
        }
        continue;
      }

      await this.updatePlatform(post.id, platform, (previous) => ({
        ...previous,
        status: "ready",
        containerId: prepared.containerId,
        childContainerIds: [...prepared.childContainerIds],
        containerStatus: prepared.status,
        preparedAt: new Date(now).toISOString(),
        nextAttemptAt: undefined,
        lastError: undefined
      }), now);

      if (!await this.quotaAllowsPublication(post.id, platform, readyPlatform.accountId, rows, now)) continue;

      const currentBeforeRequest = await this.dependencies.store.getPost(post.id);
      const platformBeforeRequest = currentBeforeRequest?.platforms[platform];
      if (!currentBeforeRequest || !platformBeforeRequest ||
        currentBeforeRequest.contentHash !== contentHash || currentBeforeRequest.enabled !== true ||
        platformBeforeRequest.status !== "ready") {
        throw new SafeError("Publish preconditions changed before the request; no publish API call was made.");
      }

      const publishRunId = getRunId();
      const requested = await this.updatePlatform(post.id, platform, (previous) => {
        if (previous.status !== "ready") throw new SafeError("Publish request was not recorded from a ready state.");
        return {
          ...previous,
          status: "publish_requested",
          publishRequestedAt: new Date(now).toISOString(),
          publishRunId,
          publishRunAttempt: getRunAttempt()
        };
      }, now);
      const verifiedRequest = await this.dependencies.store.getPost(post.id);
      if (verifiedRequest?.platforms[platform]?.status !== "publish_requested" ||
          verifiedRequest.platforms[platform]?.publishRunId !== publishRunId) {
        throw new SafeError("Publish request state was not confirmed; no publish API call was made.");
      }

      logEvent({ postId: post.id, platform, stage: "publish", status: "publish_requested" });
      const outcome = await this.dependencies.adapters[platform].publish(
        requested.accountId,
        prepared,
        post.platformTexts[platform] ?? ""
      );
      if (outcome.kind === "published") {
        const saved = await this.savePublishedOnly(post.id, platform, outcome, now);
        rows.push({ postId: post.id, platform, status: saved.status });
      } else {
        await this.updatePlatform(post.id, platform, (previous) => ({
          ...previous,
          status: "unknown",
          lastError: outcome.error
        }), now);
        rows.push({ postId: post.id, platform, status: "unknown", detail: "publish_response_unconfirmed" });
      }
    }
  }

  private async reconcileOutstanding(
    ids: string[],
    posts: ResolvedPost[],
    action: RunnerAction,
    onlyId: string | undefined,
    rows: ReportRow[],
    now: number
  ): Promise<void> {
    if (action !== "publish" && action !== "reconcile") return;
    const inputById = new Map(posts.map((post) => [post.id, post]));
    for (const id of ids) {
      if (onlyId && id !== onlyId) continue;
      const state = await this.dependencies.store.getPost(id);
      if (!state) continue;
      const input = inputById.get(id);
      for (const platform of state.desiredPlatforms) {
        const current = state.platforms[platform];
        if (!current || (current.status !== "unknown" && current.status !== "publish_requested")) continue;
        const outcome = await this.dependencies.adapters[platform].reconcile(current);
        if (outcome.kind === "published") {
          await this.updatePlatform(id, platform, (previous) => ({
            ...previous,
            status: "published",
            ...(outcome.postId ? { postId: outcome.postId } : {}),
            ...(outcome.permalink ? { permalink: outcome.permalink } : {}),
            publishedAt: new Date(now).toISOString(),
            confirmedBy: outcome.confirmedBy,
            lastError: undefined
          }), now);
          rows.push({ postId: id, platform, status: "published", detail: "verified_read_only_reconciliation" });
        } else {
          const nextStatus = current.status === "publish_requested" ? "unknown" : current.status;
          if (nextStatus !== current.status) {
            await this.updatePlatform(id, platform, (previous) => ({
              ...previous,
              status: "unknown",
              lastError: latestError("network", "reconcile_unverified", outcome.detail)
            }), now);
          }
          rows.push({
            postId: id,
            platform,
            status: "unknown",
            detail: input?.enabled === false ? "disabled_input_reconcile_only" : outcome.detail
          });
        }
      }
    }
  }

  private async recover(request: PublisherRequest, rows: ReportRow[], inputErrors: string[], now: number): Promise<RunReport> {
    if (!request.postId || !request.recovery) throw new SafeError("Recovery requires an ID, platform, explicit confirmation, and evidence.");
    const recovery = request.recovery;
    const evidence = validateRecoveryEvidence(recovery.evidence);
    const state = await this.dependencies.store.getPost(request.postId);
    if (!state) throw new SafeError("Recovery post ID is not registered.");
    const current = state.platforms[recovery.platform];
    if (!current || (current.status !== "unknown" && current.status !== "publish_requested")) {
      throw new SafeError("Only unknown or publish_requested results can be recovered as not published.");
    }
    await this.updatePlatform(request.postId, recovery.platform, (previous) => ({
      ...previous,
      status: "pending",
      attempts: 0,
      childContainerIds: [],
      containerId: undefined,
      containerStatus: undefined,
      publishRequestedAt: undefined,
      publishRunId: undefined,
      publishRunAttempt: undefined,
      postId: undefined,
      permalink: undefined,
      publishedAt: undefined,
      confirmedBy: undefined,
      nextAttemptAt: undefined,
      lastError: undefined,
      recoveryHistory: [...previous.recoveryHistory.slice(-49), {
        at: new Date(now).toISOString(),
        runId: getRunId(),
        evidence,
        previousAttempts: previous.attempts,
        previousContainerId: previous.containerId,
        previousChildContainerIds: [...previous.childContainerIds],
        action: "confirmed_not_published"
      }]
    }), now);
    rows.push({ postId: request.postId, platform: recovery.platform, status: "pending", detail: "operator_confirmed_not_published" });
    return { rows, inputErrors, failed: false };
  }

  private async retryFailed(request: PublisherRequest, rows: ReportRow[], inputErrors: string[], now: number): Promise<RunReport> {
    if (!request.postId || !request.recovery) throw new SafeError("retry-failed requires an ID, platform, explicit confirmation, and evidence.");
    const recovery = request.recovery;
    const evidence = validateRecoveryEvidence(recovery.evidence);
    const state = await this.dependencies.store.getPost(request.postId);
    if (!state) throw new SafeError("Retry post ID is not registered.");
    const current = state.platforms[recovery.platform];
    if (!current || current.status !== "failed" || current.lastError?.stage === "publish" ||
        current.publishRequestedAt || current.publishRunId || current.publishRunAttempt || current.publishedAt || current.confirmedBy) {
      throw new SafeError("retry-failed applies only to a definite failed result before the publish request.");
    }
    await this.updatePlatform(request.postId, recovery.platform, (previous) => ({
      ...previous,
      status: "pending",
      attempts: 0,
      childContainerIds: [],
      containerId: undefined,
      containerStatus: undefined,
      preparedAt: undefined,
      publishRequestedAt: undefined,
      publishRunId: undefined,
      publishRunAttempt: undefined,
      postId: undefined,
      permalink: undefined,
      publishedAt: undefined,
      confirmedBy: undefined,
      nextAttemptAt: undefined,
      lastError: undefined,
      recoveryHistory: [...previous.recoveryHistory.slice(-49), {
        at: new Date(now).toISOString(),
        runId: getRunId(),
        evidence,
        previousAttempts: previous.attempts,
        previousContainerId: previous.containerId,
        previousChildContainerIds: [...previous.childContainerIds],
        action: "confirmed_not_published"
      }]
    }), now);
    rows.push({ postId: request.postId, platform: recovery.platform, status: "pending", detail: "operator_retried_definite_failure" });
    return { rows, inputErrors, failed: false };
  }

  private async updatePost(id: string, update: (state: StoredPostState) => StoredPostState, now: number): Promise<StoredPostState> {
    return this.dependencies.store.mutatePost(id, (current) => withTimestamp(update(current), now));
  }

  private async quotaAllowsPublication(id: string, platform: Platform, accountId: string, rows: ReportRow[], now: number): Promise<boolean> {
    let detail: PlatformRequestError;
    try {
      const quota = await this.dependencies.adapters[platform].checkPublishingQuota(accountId);
      if (quota.usage < quota.total) return true;
      detail = new PlatformRequestError({ category: "rate_limit", stage: "publishing_quota",
        message: "Publishing quota is exhausted; publication was deferred." }, true);
    } catch (error) {
      if (!(error instanceof PlatformRequestError)) throw error;
      detail = error;
    }
    // A quota read happens before the publish checkpoint. It cannot make a post's outcome unknown.
    // Retain ready containers and preparation attempts while waiting for the rolling quota window.
    const retryable = detail.retryable;
    const requestedDelay = detail.retryAfterMs;
    const delay = Math.max(20 * 60_000,
      requestedDelay !== undefined && Number.isFinite(requestedDelay) && requestedDelay >= 0
        ? Math.min(requestedDelay, 24 * 60 * 60_000) : 0);
    await this.updatePlatform(id, platform, (previous) => ({
      ...previous,
      status: retryable ? (previous.status === "ready" ? "ready" : "retry_wait") : "failed",
      nextAttemptAt: retryable ? new Date(now + delay).toISOString() : undefined,
      lastError: detail.detail
    }), now);
    rows.push({ postId: id, platform, status: retryable ? "retry_wait" : "failed", detail: "publishing_quota" });
    return false;
  }

  private async updatePlatform(
    id: string,
    platform: Platform,
    update: (state: PlatformState) => PlatformState,
    now: number
  ): Promise<PlatformState> {
    const post = await this.updatePost(id, (current) => {
      const previous = current.platforms[platform];
      if (!previous) throw new SafeError("Stored platform state is missing.");
      return {
        ...current,
        platforms: { ...current.platforms, [platform]: update(clonePlatform(previous)) }
      };
    }, now);
    return post.platforms[platform]!;
  }

  private async savePublishedOnly(
    id: string,
    platform: Platform,
    outcome: { kind: "published"; postId: string; permalink?: string },
    now: number
  ): Promise<PlatformState> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.updatePlatform(id, platform, (previous) => {
          if (previous.status !== "publish_requested") throw new SafeError("Published result no longer matches the durable request state.");
          return {
            ...previous,
            status: "published",
            postId: outcome.postId,
            ...(outcome.permalink ? { permalink: outcome.permalink } : {}),
            publishedAt: new Date(now).toISOString(),
            confirmedBy: "publish_response",
            lastError: undefined
          };
        }, now);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw new SafeError("SNS published successfully, but saving the result failed. The existing publish_requested checkpoint remains for read-only reconciliation.");
    throw new SafeError("SNS published successfully, but saving the result failed.");
  }
}
