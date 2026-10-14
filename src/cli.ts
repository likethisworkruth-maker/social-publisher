import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Publisher } from "./publisher.js";
import { MemoryStateStore } from "./state.js";
import { createAdapters } from "./platforms.js";
import { loadPosts } from "./posts.js";
import { GitHubStateStore, makeGitHubClient, repositoryFromEnvironmentOrGit, type WorkflowDispatchResult } from "./github.js";
import { SafeError, assertSafePostId, secretFromEnvironmentOrGh, validateRecoveryEvidence } from "./utils.js";
import type { Platform } from "./types.js";
import { createSample, runLocalDemo } from "./local.js";

export interface Args {
  id?: string;
  dryRun: boolean;
  now: boolean;
  platform?: Platform;
  confirmNotPublished: boolean;
  evidence?: string;
}

export function buildWorkflowDispatchInputs(
  action: "publish" | "reconcile" | "recover" | "retry-failed",
  args: Args,
  sourceCommit: string
): Record<string, string> {
  const recoveryEvidence = action === "recover" || action === "retry-failed" ? validateRecoveryEvidence(args.evidence!) : (args.evidence ?? "");
  return {
    action,
    source_commit: sourceCommit,
    id: args.id ?? "",
    publish_now: String(args.now),
    recovery_platform: args.platform ?? "instagram",
    confirmed_not_published: String(args.confirmNotPublished),
    recovery_evidence: recoveryEvidence
  };
}

export function workflowTrackingUrl(result: WorkflowDispatchResult | undefined, fallback: string): string {
  if (typeof result?.html_url !== "string") return fallback;
  try {
    const parsed = new URL(result.html_url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.toString();
  } catch {
    // The workflow list page remains a safe fallback for legacy or malformed dispatch responses.
  }
  return fallback;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { dryRun: false, now: false, confirmNotPublished: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--dry-run") result.dryRun = true;
    else if (value === "--now") result.now = true;
    else if (value === "--confirm-not-published") result.confirmNotPublished = true;
    else if (value === "--id" || value === "--platform" || value === "--evidence") {
      const next = argv[index + 1];
      if (!next) throw new SafeError(value + " requires a value.");
      index += 1;
      if (value === "--id") {
        assertSafePostId(next);
        result.id = next;
      } else if (value === "--platform") {
        if (next !== "instagram" && next !== "threads") throw new SafeError("--platform must be instagram or threads.");
        result.platform = next;
      } else {
        result.evidence = next;
      }
    } else {
      throw new SafeError("Unknown command option: " + value + ".");
    }
  }
  return result;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new SafeError("Git metadata is unavailable; workflow dispatch requires a clean, pushed default-branch checkout.");
  }
}

async function ensureCleanDefaultBranch(repository: string, defaultBranch: string): Promise<string> {
  if (git(["status", "--porcelain"]).length) {
    throw new SafeError("The working tree has uncommitted changes; commit and push the intended posts before dispatching.");
  }
  const branch = git(["branch", "--show-current"]);
  if (branch !== defaultBranch) throw new SafeError("Workflow dispatch requires the GitHub default branch.");
  const remote = git(["remote", "get-url", "origin"]);
  const normalized = remote.replace(/\.git$/, "").replace(/:/, "/").split("github.com/")[1];
  if (!normalized || normalized.toLowerCase() !== repository.toLowerCase()) {
    throw new SafeError("The origin remote does not match the configured GitHub repository.");
  }
  const head = git(["rev-parse", "HEAD"]);
  const upstream = git(["rev-parse", "--verify", "@{u}"]);
  if (head !== upstream) throw new SafeError("The default branch has local commits that are not pushed. Push before dispatching.");
  return head;
}

async function dispatch(action: "publish" | "reconcile" | "recover" | "retry-failed", args: Args): Promise<void> {
  if (args.now && (!args.id || action !== "publish")) throw new SafeError("--now requires one explicit post ID and is valid only for publish.");
  if (action === "reconcile" && !args.id) throw new SafeError("reconcile requires --id.");
  if ((action === "recover" || action === "retry-failed") && (!args.id || !args.platform || !args.confirmNotPublished || !args.evidence || args.evidence.trim().length < 20)) {
    throw new SafeError(action + " requires --id, --platform, --confirm-not-published, and evidence of at least 20 characters.");
  }
  const repository = repositoryFromEnvironmentOrGit();
  const client = makeGitHubClient(secretFromEnvironmentOrGh(), repository);
  const metadata = await client.repositoryInfo();
  const head = await ensureCleanDefaultBranch(repository, metadata.default_branch);
  const remoteHead = await client.branchCommit(metadata.default_branch);
  if (head !== remoteHead) throw new SafeError("The local default branch is not the current GitHub default branch commit. Pull before dispatching.");
  const inputs = buildWorkflowDispatchInputs(action, args, head);
  const dispatchResult = await client.dispatchWorkflow("publish.yml", metadata.default_branch, inputs);
  const server = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
  const workflowPage = server + "/" + repository + "/actions/workflows/publish.yml";
  console.log("Workflow dispatch accepted for source commit " + head + ".");
  console.log("Track the run at " + workflowTrackingUrl(dispatchResult, workflowPage));
  console.log("A successful dispatch does not confirm an SNS post; check the run's SNS-specific result.");
}

async function localDryRun(id: string | undefined, postsRoot: string): Promise<void> {
  const loaded = await loadPosts(postsRoot);
  for (const error of loaded.errors) console.error("input_error=" + error);
  const publisher = new Publisher({ store: new MemoryStateStore(), adapters: createAdapters(process.env) });
  const report = await publisher.run({
    action: "dry-run",
    posts: loaded.posts,
    inputErrors: loaded.errors,
    ...(id ? { postId: id } : {})
  });
  for (const row of report.rows) console.log("post_id=" + row.postId + " platform=" + row.platform + " status=" + row.status);
  console.log("Local preview only; durable publication state was not read.");
  console.log("Published status is unverified in this preview.");
  if (report.failed) process.exitCode = 1;
}

export async function runCli(argv = process.argv.slice(2), postsRoot = path.resolve("posts")): Promise<void> {
  const command = argv[0] ?? "publish";
  const args = parseArgs(argv.slice(1));
  // PowerShell's npm.ps1 may consume the separator and pass --dry-run as npm configuration.
  // Preserve the user's non-publishing intent even when the option does not reach process.argv.
  if (command === "publish" && process.env.npm_config_dry_run === "true") args.dryRun = true;
  if (command === "preview") {
    if (args.now || args.platform || args.confirmNotPublished || args.evidence) throw new SafeError("preview accepts only --id.");
    return localDryRun(args.id, postsRoot);
  }
  if (command === "sample" || command === "demo") {
    if (args.dryRun || args.now || args.platform || args.confirmNotPublished || args.evidence || (command === "demo" && args.id)) {
      throw new SafeError("sample accepts only --id; demo takes no options.");
    }
    if (command === "demo") return runLocalDemo();
    console.log("Sample created at " + await createSample(args.id, postsRoot));
    console.log("enabled=false: edit the image, text, schedule, and enabled flag before publication.");
    return;
  }
  if (command === "validate") {
    const loaded = await loadPosts(postsRoot);
    console.log("valid_posts=" + loaded.posts.length + " invalid_posts=" + loaded.errors.length);
    for (const post of loaded.posts) {
      console.log("post_id=" + post.id + " input_hash=" + post.inputHash + " image_hashes=" + post.resolvedImages.map((image) => image.name + ":" + image.sha256).join(","));
    }
    for (const error of loaded.errors) console.error("input_error=" + error);
    if (loaded.errors.length) process.exitCode = 1;
    return;
  }
  if (command === "publish") {
    if (args.dryRun && args.now) throw new SafeError("Local Dry Run does not apply --now; omit it to preview the saved schedule.");
    if (args.dryRun) return localDryRun(args.id, postsRoot);
    if (args.id) {
      const loaded = await loadPosts(postsRoot);
      if (!loaded.posts.some((post) => post.id === args.id) && !loaded.errors.some((error) => error.startsWith(args.id + ":"))) {
        throw new SafeError("Requested post ID is not present in the local input.");
      }
    }
    return dispatch("publish", args);
  }
  if (command === "reconcile") {
    if (args.dryRun || args.now || args.confirmNotPublished) throw new SafeError("reconcile accepts only --id.");
    return dispatch("reconcile", args);
  }
  if (command === "recover") {
    if (args.dryRun || args.now) throw new SafeError("recover does not accept --dry-run or --now.");
    return dispatch("recover", args);
  }
  if (command === "retry-failed") {
    if (args.dryRun || args.now) throw new SafeError("retry-failed does not accept --dry-run or --now.");
    return dispatch("retry-failed", args);
  }
  if (command === "state:init") {
    if (args.id || args.dryRun || args.now || args.platform || args.confirmNotPublished || args.evidence) throw new SafeError("state:init takes no options.");
    const repository = repositoryFromEnvironmentOrGit();
    const client = makeGitHubClient(secretFromEnvironmentOrGh(), repository);
    await new GitHubStateStore(client).initialize();
    console.log("The orphan publisher-state branch was initialized and verified for " + repository + ".");
    return;
  }
  throw new SafeError("Command must be sample, demo, preview, validate, publish, reconcile, recover, retry-failed, or state:init.");
}

const currentFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (currentFile && pathToFileURL(currentFile).href === import.meta.url) {
  runCli().catch((error: unknown) => {
    const message = error instanceof SafeError ? error.message : "Command stopped safely after an unexpected error.";
    console.error(message);
    process.exitCode = 1;
  });
}
