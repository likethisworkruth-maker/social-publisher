import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectJpeg, loadPosts } from "./posts.js";
import { StateStoreError, type StateStore } from "./state.js";
import type { AssetManifest, AssetManifestEntry, ResolvedPost } from "./types.js";
import { SafeError, assertSafePostId, getSourceCommit, sha256 } from "./utils.js";

export interface VerifiedAssets {
  manifest: AssetManifest;
  urls: string[];
}

export class AssetUnavailableError extends SafeError {
  constructor(message: string) {
    super(message);
    this.name = "AssetUnavailableError";
  }
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SafeError("Asset base URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SafeError("Asset base URL must be public HTTPS without credentials, query, or fragment.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function makeAssetManifest(
  post: ResolvedPost,
  baseUrl: string,
  deploymentId: string,
  sourceCommit = getSourceCommit()
): AssetManifest {
  const base = normalizeBaseUrl(baseUrl);
  const assets: AssetManifestEntry[] = post.resolvedImages.map((image) => ({
    name: image.name,
    url: new URL(encodeURIComponent(post.id) + "/" + image.sha256 + "/" + encodeURIComponent(image.name) + "/", base + "/").toString().replace(/\/$/, ""),
    sha256: image.sha256,
    size: image.size
  }));
  return {
    schemaVersion: 1,
    id: post.id,
    inputHash: post.inputHash,
    sourceCommit,
    deploymentId,
    createdAt: new Date().toISOString(),
    baseUrl: base,
    assets
  };
}

export async function downloadVerifiedAsset(url: string, expectedHash: string, expectedSize: number): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeError("Asset URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new SafeError("Asset URL must be public HTTPS without credentials, query, or fragment.");
  let response: Response;
  try {
    response = await fetch(parsed, { method: "GET", redirect: "error", headers: { Accept: "image/jpeg" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new AssetUnavailableError("Public image could not be retrieved yet.");
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new AssetUnavailableError("Public image is not available yet (HTTP " + response.status + ").");
    }
    throw new SafeError("Public image returned HTTP " + response.status + ".");
  }
  try {
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) throw new SafeError("Public image redirected to a non-public URL.");
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("Public image redirected to an invalid URL.");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "image/jpeg") throw new SafeError("Public image response is not image/jpeg.");
  const reader = response.body?.getReader();
  if (!reader) throw new AssetUnavailableError("Public image response has no readable body yet.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 5_000_000) {
        await reader.cancel();
        throw new SafeError("Public image exceeds 5,000,000 bytes.");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new AssetUnavailableError("Public image could not be fully retrieved yet.");
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (bytes.length !== expectedSize) throw new SafeError("Public image size does not match the source.");
  if (sha256(bytes) !== expectedHash) throw new SafeError("Public image content hash does not match the source.");
  const details = inspectJpeg(bytes);
  if (details.width !== 1080 || details.height !== 1080 || !details.srgb) throw new SafeError("Public image failed the JPEG dimensions or sRGB check.");
  return bytes;
}

export async function verifyAssetUrl(url: string, expectedHash: string, expectedSize: number): Promise<void> {
  await downloadVerifiedAsset(url, expectedHash, expectedSize);
}

export async function resolveAndVerifyAssets(
  post: ResolvedPost,
  store: StateStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<VerifiedAssets> {
  const mode = env.ASSET_MODE ?? "pages";
  let manifest: AssetManifest | null;
  if (mode === "pages") {
    try {
      manifest = await store.getAssetManifest(post.id);
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      throw new StateStoreError("Asset manifest could not be read from the state branch; publishing is stopped.");
    }
    if (!manifest) throw new AssetUnavailableError("GitHub Pages asset manifest is not available yet.");
    if (manifest.inputHash !== post.inputHash) throw new AssetUnavailableError("GitHub Pages asset manifest is for an earlier post input; waiting for its deployment.");
  } else if (mode === "fixed-url") {
    const base = env.ASSET_BASE_URL;
    if (!base) throw new SafeError("ASSET_BASE_URL is required when ASSET_MODE=fixed-url.");
    manifest = makeAssetManifest(post, base, "fixed-url");
    try {
      await store.saveAssetManifest(manifest);
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      throw new StateStoreError("Asset manifest could not be saved to the state branch; publishing is stopped.");
    }
  } else {
    throw new SafeError("ASSET_MODE must be pages or fixed-url.");
  }

  if (manifest.assets.length !== post.resolvedImages.length) throw new AssetUnavailableError("GitHub Pages asset manifest image count is for an earlier input; waiting for its deployment.");
  const urls: string[] = [];
  for (let index = 0; index < post.resolvedImages.length; index += 1) {
    const image = post.resolvedImages[index]!;
    const asset = manifest.assets[index];
    if (!asset || asset.name !== image.name || asset.sha256 !== image.sha256 || asset.size !== image.size) {
      throw new AssetUnavailableError("GitHub Pages asset manifest is for an earlier image set; waiting for its deployment.");
    }
    await verifyAssetUrl(asset.url, image.sha256, image.size);
    urls.push(asset.url);
  }
  return { manifest, urls };
}

export async function preparePagesArtifact(
  postsRoot: string,
  outputRoot: string,
  manifestPath: string,
  previousManifests: AssetManifest[] = []
): Promise<{ validCount: number; errors: string[] }> {
  const loaded = await loadPosts(postsRoot);
  await mkdir(outputRoot, { recursive: true });
  const manifests: AssetManifest[] = [];
  for (const post of loaded.posts) {
    const entries: AssetManifestEntry[] = [];
    for (const image of post.resolvedImages) {
      const relative = path.join(post.id, image.sha256, image.name);
      const target = path.join(outputRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(image.path, target);
      entries.push({ name: image.name, url: relative.replaceAll(path.sep, "/"), sha256: image.sha256, size: image.size });
    }
    manifests.push({
      schemaVersion: 1,
      id: post.id,
      inputHash: post.inputHash,
      sourceCommit: getSourceCommit(),
      deploymentId: "pending-pages-deployment",
      createdAt: new Date().toISOString(),
      baseUrl: "",
      assets: entries
    });
  }
  const copied = new Set<string>();
  for (const manifest of manifests) {
    for (const image of manifest.assets) copied.add(path.join(manifest.id, image.sha256, image.name));
  }
  for (const manifest of previousManifests) {
    assertSafePostId(manifest.id);
    for (const asset of [...manifest.assets, ...(manifest.retainedAssets ?? [])]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.jpe?g$/i.test(asset.name) || asset.name.includes("..") ||
          !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isInteger(asset.size) || asset.size < 1 || asset.size > 5_000_000) {
        throw new StateStoreError("Historical asset manifest contains an invalid image entry.");
      }
      const relative = path.join(manifest.id, asset.sha256, asset.name);
      if (copied.has(relative)) continue;
      const bytes = await downloadVerifiedAsset(asset.url, asset.sha256, asset.size);
      const target = path.join(outputRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      copied.add(relative);
    }
  }
  await writeFile(manifestPath, JSON.stringify({ manifests, errors: loaded.errors }, null, 2) + "\n", "utf8");
  await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");
  await writeFile(path.join(outputRoot, "index.html"), "<!doctype html><title>Social publisher assets</title>\n", "utf8");
  return { validCount: manifests.length, errors: loaded.errors };
}

export async function readPreparedManifests(filePath: string): Promise<{ manifests: AssetManifest[]; errors: string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new SafeError("Prepared asset manifest artifact is missing or invalid.");
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).manifests) || !Array.isArray((value as Record<string, unknown>).errors)) {
    throw new SafeError("Prepared asset manifest artifact is malformed.");
  }
  return value as { manifests: AssetManifest[]; errors: string[] };
}

export function finalizePagesManifest(manifest: AssetManifest, baseUrl: string, deploymentId: string): AssetManifest {
  const base = normalizeBaseUrl(baseUrl);
  return {
    ...manifest,
    baseUrl: base,
    deploymentId,
    assets: manifest.assets.map((asset) => ({
      ...asset,
      url: new URL(asset.url.split("/").map(encodeURIComponent).join("/"), base + "/").toString()
    }))
  };
}
