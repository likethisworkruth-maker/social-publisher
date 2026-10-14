import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { GitHubStateStore, makeGitHubClient, repositoryFromEnvironmentOrGit } from "./github.js";
import { Publisher, type RunnerAction } from "./publisher.js";
import { createAdapters } from "./platforms.js";
import { loadPosts } from "./posts.js";
import { finalizePagesManifest, preparePagesArtifact, readPreparedManifests, verifyAssetUrl } from "./assets.js";
import { SafeError, getRunId, secretFromEnvironmentOrGh } from "./utils.js";
import type { AssetManifest, Platform, StoredPostState } from "./types.js";

function checkedAction(value: string | undefined): RunnerAction {
  if (value === "publish" || value === "dry-run" || value === "reconcile" || value === "recover" || value === "retry-failed") return value;
  throw new SafeError("Action must be publish, dry-run, reconcile, recover, or retry-failed.");
}

function summaryCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

async function writeSummary(title: string, rows: Array<{ postId: string; platform: string; status: string; detail?: string }>, warnings: string[]): Promise<void> {
  const lines = [
    "## " + title,
    "",
    "| 投稿ID | SNS | 状態 | 詳細 |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => "| " + summaryCell(row.postId) + " | " + summaryCell(row.platform) + " | " + summaryCell(row.status) + " | " + summaryCell(row.detail ?? "") + " |"),
    "",
    ...warnings.map((warning) => "- " + summaryCell(warning)),
    ""
  ];
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, lines.join("\n"), "utf8");
}

function tokenExpiryWarnings(platforms: Platform[], env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  for (const platform of platforms) {
    const variable = platform === "instagram" ? "INSTAGRAM_TOKEN_EXPIRES_AT" : "THREADS_TOKEN_EXPIRES_AT";
    const value = env[variable];
    if (!value) {
      warnings.push(platform + " token expiry is unverified; set " + variable + " before production use.");
      continue;
    }
    const expiry = Date.parse(value);
    if (!Number.isFinite(expiry)) {
      warnings.push(platform + " token expiry metadata is invalid; connection check is still required.");
    } else if (expiry <= Date.now()) {
      warnings.push(platform + " token expiry metadata is past; a new publish should be stopped.");
    } else if (expiry - Date.now() <= 7 * 24 * 60 * 60_000) {
      warnings.push(platform + " token expiry is within seven days.");
    }
  }
  return warnings;
}

async function storeForWorkflow(): Promise<GitHubStateStore> {
  const token = secretFromEnvironmentOrGh();
  const client = makeGitHubClient(token, process.env.GITHUB_REPOSITORY ?? repositoryFromEnvironmentOrGit());
  return new GitHubStateStore(client);
}

async function validateInputs(): Promise<{ posts: Awaited<ReturnType<typeof loadPosts>>["posts"]; errors: string[] }> {
  const loaded = await loadPosts(path.resolve(process.env.POSTS_ROOT ?? "posts"));
  console.log("valid_posts=" + loaded.posts.length + " invalid_posts=" + loaded.errors.length);
  for (const post of loaded.posts) {
    console.log("post_id=" + post.id + " input_hash=" + post.inputHash + " image_hashes=" + post.resolvedImages.map((image) => image.name + ":" + image.sha256).join(","));
  }
  for (const error of loaded.errors) console.error("input_error=" + error);
  return loaded;
}

async function runPublishAction(action: RunnerAction): Promise<void> {
  const loaded = await validateInputs();
  const store = await storeForWorkflow();
  const now = String(process.env.PUBLISH_NOW ?? "false").toLowerCase() === "true";
  const postId = process.env.POST_ID || undefined;
  if (now && (!postId || action !== "publish")) throw new SafeError("publish_now is valid only for one explicit post ID.");
  if (action === "publish") {
    const ids = loaded.posts.map((post) => post.id);
    if (postId && !ids.includes(postId) && !loaded.errors.some((error) => error.startsWith(postId + ":"))) {
      throw new SafeError("Requested post ID is not present in the default-branch input.");
    }
  }
  const publisher = new Publisher({ store, adapters: createAdapters(process.env) });
  let recovery: { platform: Platform; evidence: string } | undefined;
  if (action === "recover" || action === "retry-failed") {
    const platform = process.env.RECOVERY_PLATFORM;
    const evidence = process.env.RECOVERY_EVIDENCE ?? "";
    if (String(process.env.CONFIRMED_NOT_PUBLISHED).toLowerCase() !== "true" || (platform !== "instagram" && platform !== "threads")) {
      throw new SafeError("Recovery or retry requires explicit not-published confirmation and a selected SNS.");
    }
    recovery = { platform, evidence };
  }
  const report = await publisher.run({
    action,
    posts: loaded.posts,
    inputErrors: loaded.errors,
    ...(postId ? { postId } : {}),
    ...(recovery ? { recovery } : {}),
    now,
    maxLatenessMinutes: Number(process.env.MAX_LATENESS_MINUTES ?? "1440"),
    maxPostsPerRun: Number(process.env.MAX_POSTS_PER_RUN ?? "10"),
    env: process.env
  });
  const warnings = action === "publish"
    ? tokenExpiryWarnings([...new Set(loaded.posts.flatMap((post) => post.platforms))], process.env)
    : [];
  await writeSummary("Social publisher: " + action, report.rows, warnings);
  for (const row of report.rows) {
    console.log("post_id=" + row.postId + " platform=" + row.platform + " status=" + row.status +
      (row.detail ? " detail=" + row.detail.replaceAll("\n", " ") : ""));
  }
  if (report.failed) process.exitCode = 1;
}

async function saveAssetManifests(): Promise<void> {
  const filePath = process.env.PREPARED_ASSETS_FILE;
  const baseUrl = process.env.GITHUB_PAGES_URL;
  if (!filePath || !baseUrl) throw new SafeError("PREPARED_ASSETS_FILE and GITHUB_PAGES_URL are required after Pages deployment.");
  const { manifests, errors } = await readPreparedManifests(filePath);
  const loaded = await validateInputs();
  const posts = new Map(loaded.posts.map((post) => [post.id, post]));
  const store = await storeForWorkflow();
  const deploymentId = process.env.ASSET_DEPLOYMENT_ID ?? getRunId();
  let saved = 0;
  for (const pending of manifests) {
    const post = posts.get(pending.id);
    if (!post || post.inputHash !== pending.inputHash || pending.sourceCommit !== process.env.SOURCE_COMMIT) {
      errors.push(pending.id + ": deployed manifest does not match the workflow source snapshot.");
      continue;
    }
    const manifest = finalizePagesManifest(pending, baseUrl, deploymentId);
    try {
      for (const asset of manifest.assets) await verifyAssetUrl(asset.url, asset.sha256, asset.size);
      await store.saveAssetManifest(manifest);
      saved += 1;
    } catch {
      errors.push(pending.id + ": deployed image could not be fetched and hash-verified.");
    }
  }
  console.log("asset_manifests_saved=" + saved + " invalid_posts=" + errors.length);
  if (errors.length) {
    await writeSummary("Social publisher: Pages asset preparation", [], errors);
    process.exitCode = 1;
  }
}

async function reportAssetErrors(): Promise<void> {
  const filePath = process.env.PREPARED_ASSETS_FILE;
  if (!filePath) throw new SafeError("PREPARED_ASSETS_FILE is required.");
  const { errors } = await readPreparedManifests(filePath);
  if (errors.length) {
    for (const error of errors) console.error("input_error=" + error);
    await writeSummary("Social publisher: asset validation", [], errors);
    process.exitCode = 1;
  }
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "prepare-assets") {
    const output = path.resolve(process.env.ASSET_OUTPUT_DIR ?? "site");
    const manifestPath = path.resolve(process.env.PREPARED_ASSETS_FILE ?? "prepared-assets.json");
    const store = await storeForWorkflow();
    const priorManifests = await store.listAssetManifests();
    const result = await preparePagesArtifact(path.resolve(process.env.POSTS_ROOT ?? "posts"), output, manifestPath, priorManifests);
    console.log("pages_assets=" + result.validCount + " invalid_posts=" + result.errors.length);
    return;
  }
  if (mode === "save-asset-manifests") return saveAssetManifests();
  if (mode === "report-assets") return reportAssetErrors();
  if (mode === "validate") {
    const loaded = await validateInputs();
    if (loaded.errors.length) process.exitCode = 1;
    return;
  }
  const action = checkedAction(mode ?? process.env.RUNNER_ACTION);
  await runPublishAction(action);
}

const currentFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (currentFile && pathToFileURL(currentFile).href === import.meta.url) {
  run().catch((error: unknown) => {
    const message = error instanceof SafeError ? error.message : "Runner stopped safely after an unexpected error.";
    console.error(message);
    process.exitCode = 1;
  });
}
