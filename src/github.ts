import { execFileSync } from "node:child_process";
import { SafeError, canonicalJson, assertSafePostId } from "./utils.js";
import { StateStoreError, validateStoredPostState, type StateStore } from "./state.js";
import type { AssetManifest, ResolvedPost, StoredPostState } from "./types.js";

export class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super("GitHub API request failed with HTTP " + status + ".");
    this.name = "GitHubHttpError";
  }
}

export interface GitHubClientOptions {
  token: string;
  repository: string;
  apiUrl?: string;
}

export interface WorkflowDispatchResult {
  workflow_run_id?: number;
  run_url?: string;
  html_url?: string;
}

export class GitHubClient {
  readonly repository: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiUrl: string;

  constructor(options: GitHubClientOptions) {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(options.repository);
    if (!match) throw new SafeError("GITHUB_REPOSITORY must be owner/repository.");
    this.owner = match[1]!;
    this.repo = match[2]!;
    this.repository = options.repository;
    this.token = options.token;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  private get repoPath(): string {
    return "/repos/" + encodeURIComponent(this.owner) + "/" + encodeURIComponent(this.repo);
  }

  async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl + endpoint, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + this.token,
          "X-GitHub-Api-Version": "2026-03-10",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw new SafeError("GitHub API could not be reached; state was not assumed empty.");
    }
    if (!response.ok) throw new GitHubHttpError(response.status);
    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch {
      throw new SafeError("GitHub API returned an unreadable response; state was not assumed empty.");
    }
  }

  async repositoryInfo(): Promise<{ default_branch: string }> {
    return this.request("GET", this.repoPath);
  }

  async branchCommit(branch: string): Promise<string> {
    const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
    const result = await this.request<{ commit: { sha: string } }>("GET", this.repoPath + "/branches/" + encodedBranch);
    if (!result?.commit?.sha) throw new SafeError("GitHub did not return the default branch commit.");
    return result.commit.sha;
  }

  async getRef(branch: string): Promise<{ object: { sha: string } }> {
    return this.request("GET", this.repoPath + "/git/ref/heads/" + encodeURIComponent(branch));
  }

  async createStateBranch(branch: string): Promise<void> {
    const initial = JSON.stringify({ schemaVersion: 1, initialized: true, postIds: [] }, null, 2) + "\n";
    const blob = await this.request<{ sha: string }>("POST", this.repoPath + "/git/blobs", {
      content: Buffer.from(initial, "utf8").toString("base64"),
      encoding: "base64"
    });
    const tree = await this.request<{ sha: string }>("POST", this.repoPath + "/git/trees", {
      tree: [{ path: "store.json", mode: "100644", type: "blob", sha: blob.sha }]
    });
    const commit = await this.request<{ sha: string }>("POST", this.repoPath + "/git/commits", {
      message: "Initialize social publisher state",
      tree: tree.sha,
      parents: []
    });
    await this.request("POST", this.repoPath + "/git/refs", {
      ref: "refs/heads/" + branch,
      sha: commit.sha
    });
  }

  async readContent(filePath: string, branch: string): Promise<{ content: string; sha: string } | null> {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const ref = encodeURIComponent(branch);
    try {
      const response = await this.request<{ content: string; encoding: string; sha: string }>(
        "GET",
        this.repoPath + "/contents/" + encodedPath + "?ref=" + ref
      );
      if (response.encoding !== "base64" || typeof response.content !== "string" || typeof response.sha !== "string") {
        throw new StateStoreError("State file is not a base64 GitHub Contents API file.");
      }
      return {
        content: Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8"),
        sha: response.sha
      };
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async writeContent(filePath: string, branch: string, content: string, sha?: string): Promise<void> {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const body: Record<string, unknown> = {
      message: "Update social publisher state",
      content: Buffer.from(content, "utf8").toString("base64"),
      branch
    };
    if (sha) body.sha = sha;
    await this.request("PUT", this.repoPath + "/contents/" + encodedPath, body);
  }

  async getBranchPaths(branch: string): Promise<string[]> {
    const ref = await this.getRef(branch);
    const tree = await this.request<{ truncated: boolean; tree: Array<{ path: string; type: string }> }>(
      "GET",
      this.repoPath + "/git/trees/" + encodeURIComponent(ref.object.sha) + "?recursive=1"
    );
    if (tree.truncated) throw new StateStoreError("The state branch tree was truncated; integrity could not be verified.");
    return tree.tree.filter((item) => item.type === "blob").map((item) => item.path);
  }

  async dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string>): Promise<WorkflowDispatchResult | undefined> {
    return this.request<WorkflowDispatchResult | undefined>(
      "POST", this.repoPath + "/actions/workflows/" + encodeURIComponent(workflow) + "/dispatches", { ref, inputs }
    );
  }

}

interface Registry {
  schemaVersion: 1;
  initialized: true;
  postIds: string[];
}

function parseJson<T>(content: string, label: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new StateStoreError(label + " is invalid JSON; automatic publishing is stopped.");
  }
}

function validateRegistry(value: Registry): Registry {
  if (!value || value.schemaVersion !== 1 || value.initialized !== true || !Array.isArray(value.postIds)) {
    throw new StateStoreError("State registry is malformed; automatic publishing is stopped.");
  }
  const ids = value.postIds;
  if (ids.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new StateStoreError("State registry contains invalid or duplicate IDs; automatic publishing is stopped.");
  }
  return value;
}

export class GitHubStateStore implements StateStore {
  private readonly branch: string;

  constructor(private readonly client: GitHubClient, branch = process.env.STATE_BRANCH ?? "publisher-state") {
    this.branch = branch;
  }

  private async requireBranch(): Promise<void> {
    try {
      await this.client.getRef(this.branch);
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        throw new StateStoreError("State branch is missing; initialize or restore it before publishing.");
      }
      throw new StateStoreError("State branch could not be verified; automatic publishing is stopped.");
    }
  }

  private async readRegistry(): Promise<{ registry: Registry; sha: string }> {
    await this.requireBranch();
    const file = await this.client.readContent("store.json", this.branch);
    if (!file) throw new StateStoreError("State registry is missing; automatic publishing is stopped.");
    const registry = validateRegistry(parseJson<Registry>(file.content, "State registry"));
    return { registry, sha: file.sha };
  }

  private async readRecord(id: string): Promise<{ record: StoredPostState; sha: string } | null> {
    assertSafePostId(id);
    const file = await this.client.readContent("posts/" + id + ".json", this.branch);
    if (!file) return null;
    const record = validateStoredPostState(parseJson<unknown>(file.content, "Post state"), id);
    return { record, sha: file.sha };
  }

  async listPostIds(): Promise<string[]> {
    const { registry } = await this.readRegistry();
    const paths = await this.client.getBranchPaths(this.branch);
    const postPaths = paths.filter((item) => item.startsWith("posts/"));
    const files: string[] = [];
    for (const item of postPaths) {
      const match = /^posts\/([a-z0-9][a-z0-9-]{0,79})\.json$/.exec(item);
      if (!match) throw new StateStoreError("State branch contains an invalid post path; automatic publishing is stopped.");
      files.push(match[1]!);
    }
    const registered = new Set(registry.postIds);
    const tracked = new Set(files);
    if (files.length !== tracked.size || registry.postIds.some((id) => !tracked.has(id)) || files.some((id) => !registered.has(id))) {
      throw new StateStoreError("Registered IDs and state files disagree; automatic publishing is stopped.");
    }
    return [...registry.postIds].sort();
  }

  async getPost(id: string): Promise<StoredPostState | null> {
    const { registry } = await this.readRegistry();
    const listed = registry.postIds.includes(id);
    const file = await this.readRecord(id);
    if (listed !== Boolean(file)) throw new StateStoreError("Registered IDs and post state disagree; automatic publishing is stopped.");
    return file?.record ?? null;
  }

  async ensurePost(post: ResolvedPost, initial: StoredPostState): Promise<StoredPostState> {
    assertSafePostId(post.id);
    for (let conflictAttempt = 0; conflictAttempt < 3; conflictAttempt += 1) {
      const { registry, sha } = await this.readRegistry();
      validateStoredPostState(initial, post.id);
      const stateFile = await this.readRecord(post.id);
      const registered = registry.postIds.includes(post.id);
      if (registered && !stateFile) throw new StateStoreError("A registered post state file is missing; automatic publishing is stopped.");
      if (!registered && stateFile) throw new StateStoreError("A post state file exists without registry registration; automatic publishing is stopped.");
      if (stateFile) return stateFile.record;
      const updated: Registry = { ...registry, postIds: [...registry.postIds, post.id].sort() };
      try {
        await this.client.writeContent("store.json", this.branch, JSON.stringify(updated, null, 2) + "\n", sha);
        const check = await this.readRegistry();
        if (!check.registry.postIds.includes(post.id)) throw new StateStoreError("Post ID registration could not be confirmed.");
        await this.client.writeContent("posts/" + post.id + ".json", this.branch, JSON.stringify(initial, null, 2) + "\n");
        const created = await this.readRecord(post.id);
        if (!created) throw new StateStoreError("Initial post state could not be confirmed.");
        return created.record;
      } catch (error) {
        if (error instanceof GitHubHttpError && (error.status === 409 || error.status === 422)) {
          const latest = await this.readRegistry();
          if (latest.registry.postIds.includes(post.id) && await this.readRecord(post.id)) return (await this.readRecord(post.id))!.record;
          if (conflictAttempt < 2) continue;
        }
        throw error;
      }
    }
    throw new StateStoreError("State registration conflicted repeatedly; automatic publishing is stopped.");
  }

  async mutatePost(id: string, update: (current: StoredPostState) => StoredPostState): Promise<StoredPostState> {
    for (let conflictAttempt = 0; conflictAttempt < 3; conflictAttempt += 1) {
      const { registry } = await this.readRegistry();
      if (!registry.postIds.includes(id)) throw new StateStoreError("Post ID is not registered; automatic publishing is stopped.");
      const file = await this.readRecord(id);
      if (!file) throw new StateStoreError("A registered post state file is missing; automatic publishing is stopped.");
      const next = update(JSON.parse(JSON.stringify(file.record)) as StoredPostState);
      if (next.id !== id || next.schemaVersion !== 1) throw new StateStoreError("State update attempted to change the post identity.");
      validateStoredPostState(next, id);
      try {
        await this.client.writeContent("posts/" + id + ".json", this.branch, JSON.stringify(next, null, 2) + "\n", file.sha);
        const verified = await this.readRecord(id);
        if (!verified || canonicalJson(verified.record) !== canonicalJson(next)) {
          throw new StateStoreError("State save could not be confirmed; no new publish request will be made.");
        }
        return verified.record;
      } catch (error) {
        if (error instanceof GitHubHttpError && (error.status === 409 || error.status === 422)) continue;
        throw error;
      }
    }
    throw new StateStoreError("State update conflicted repeatedly; automatic publishing is stopped.");
  }

  async getAssetManifest(id: string): Promise<AssetManifest | null> {
    assertSafePostId(id);
    await this.requireBranch();
    const file = await this.client.readContent("assets/" + id + ".json", this.branch);
    if (!file) return null;
    const manifest = parseJson<AssetManifest>(file.content, "Asset manifest");
    if (manifest.schemaVersion !== 1 || manifest.id !== id || !Array.isArray(manifest.assets) ||
        (manifest.retainedAssets !== undefined && !Array.isArray(manifest.retainedAssets))) {
      throw new StateStoreError("Asset manifest is malformed; publishing is stopped.");
    }
    return manifest;
  }

  async listAssetManifests(): Promise<AssetManifest[]> {
    await this.requireBranch();
    const paths = await this.client.getBranchPaths(this.branch);
    const assetPaths = paths.filter((item) => item.startsWith("assets/"));
    const ids: string[] = [];
    for (const item of assetPaths) {
      const match = /^assets\/([a-z0-9][a-z0-9-]{0,79})\.json$/.exec(item);
      if (!match) throw new StateStoreError("State branch contains an invalid asset path; asset history could not be preserved.");
      ids.push(match[1]!);
    }
    if (new Set(ids).size !== ids.length) throw new StateStoreError("State branch contains duplicate asset manifests.");
    const manifests: AssetManifest[] = [];
    for (const id of ids.sort()) {
      const manifest = await this.getAssetManifest(id);
      if (!manifest) throw new StateStoreError("Asset manifest disappeared while reading the state branch.");
      manifests.push(manifest);
    }
    return manifests;
  }

  async saveAssetManifest(manifest: AssetManifest): Promise<void> {
    assertSafePostId(manifest.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.requireBranch();
      const filePath = "assets/" + manifest.id + ".json";
      const previous = await this.client.readContent(filePath, this.branch);
      const previousManifest = previous ? parseJson<AssetManifest>(previous.content, "Asset manifest") : null;
      if (previousManifest && (previousManifest.schemaVersion !== 1 || previousManifest.id !== manifest.id ||
          !Array.isArray(previousManifest.assets) || (previousManifest.retainedAssets !== undefined && !Array.isArray(previousManifest.retainedAssets)))) {
        throw new StateStoreError("Previous asset manifest is malformed; asset history could not be preserved.");
      }
      const currentUrls = new Set(manifest.assets.map((asset) => asset.url));
      const retained = new Map<string, AssetManifest["assets"][number]>();
      for (const asset of [...(previousManifest?.retainedAssets ?? []), ...(previousManifest?.assets ?? []), ...(manifest.retainedAssets ?? [])]) {
        if (!currentUrls.has(asset.url)) retained.set(asset.url, asset);
      }
      const next = { ...manifest, retainedAssets: [...retained.values()] };
      try {
        await this.client.writeContent(filePath, this.branch, JSON.stringify(next, null, 2) + "\n", previous?.sha);
        const verified = await this.getAssetManifest(manifest.id);
        if (!verified || canonicalJson(verified) !== canonicalJson(next)) throw new StateStoreError("Asset manifest save could not be confirmed.");
        return;
      } catch (error) {
        if (error instanceof GitHubHttpError && (error.status === 409 || error.status === 422)) continue;
        throw error;
      }
    }
    throw new StateStoreError("Asset manifest update conflicted repeatedly.");
  }

  async initialize(): Promise<void> {
    try {
      await this.client.getRef(this.branch);
      await this.listPostIds();
      return;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        // Explicit state:init is the only operation allowed to create the state branch.
      } else if (error instanceof StateStoreError && error.message.includes("State branch is missing")) {
        // Explicit state:init is the only operation allowed to create the state branch.
      } else {
        throw error;
      }
    }
    try {
      await this.client.createStateBranch(this.branch);
    } catch (error) {
      if (!(error instanceof GitHubHttpError && (error.status === 409 || error.status === 422))) throw error;
    }
    await this.listPostIds();
  }
}

export function repositoryFromEnvironmentOrGit(): string {
  const configured = process.env.GITHUB_REPOSITORY;
  if (configured) return configured;
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    if (match) return match[1]!;
  } catch {
    // Report the missing remote without exposing credential-bearing remote URLs.
  }
  throw new SafeError("No GitHub repository is configured. Set GITHUB_REPOSITORY or add a GitHub origin remote.");
}

export function makeGitHubClient(token: string, repository = repositoryFromEnvironmentOrGit()): GitHubClient {
  return new GitHubClient({ token, repository, apiUrl: process.env.GITHUB_API_URL });
}
