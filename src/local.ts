import { constants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPosts } from "./posts.js";
import { Publisher } from "./publisher.js";
import { MemoryStateStore } from "./state.js";
import { PlatformRequestError, type PlatformAdapter } from "./platforms.js";
import { assertSafePostId, SafeError } from "./utils.js";
import type { Platform } from "./types.js";

const examplesRoot = fileURLToPath(new URL("../examples", import.meta.url));

async function samplePost() {
  const loaded = await loadPosts(examplesRoot);
  const post = loaded.posts.find((item) => item.id === "sample-post");
  if (!post || loaded.errors.length) throw new SafeError("The bundled sample is missing or invalid.");
  return post;
}

export async function createSample(id = "sample-post", postsRoot = path.resolve("posts")): Promise<string> {
  assertSafePostId(id);
  const post = await samplePost();
  await mkdir(postsRoot, { recursive: true });
  const target = path.join(postsRoot, id);
  try {
    await mkdir(target);
  } catch {
    throw new SafeError("Sample destination already exists or cannot be created; no files were overwritten.");
  }
  for (const image of post.resolvedImages) {
    await copyFile(image.path, path.join(target, image.name), constants.COPYFILE_EXCL);
  }
  const input = {
    schemaVersion: 1, id, enabled: false, publishAt: post.publishAt,
    text: post.text, images: post.images, platforms: post.platforms, overrides: post.overrides
  };
  await writeFile(path.join(target, "post.json"), JSON.stringify(input, null, 2) + "\n", { flag: "wx" });
  return target;
}

export async function runLocalDemo(): Promise<void> {
  console.log("ローカルデモ：SNS・GitHub・画像ホストには接続せず、実投稿は行いません。");
  const sample = await samplePost();
  const now = Date.now();
  const post = { ...sample, enabled: true, publishAt: new Date(now - 1000).toISOString(), publishAtMs: now - 1000 };
  const counts: Record<Platform, number> = { instagram: 0, threads: 0 };
  let threadsPreparationAttempts = 0;
  function adapter(platform: Platform): PlatformAdapter {
    return {
      platform,
      validateConfiguration() {},
      async checkPublishingQuota() { return { usage: 0, total: 10, durationSeconds: 86400 }; },
      async prepare(_post, state, _urls, checkpoint) {
        if (platform === "threads" && ++threadsPreparationAttempts === 1) {
          throw new PlatformRequestError({ category: "rate_limit", stage: "create_container",
            message: "Simulated preparation failure." }, true);
        }
        const containerId = state.containerId ?? "demo-" + platform + "-container";
        await checkpoint({ containerId, childContainerIds: [] });
        return { containerId, childContainerIds: [], ready: true, status: "FINISHED" };
      },
      async publish() {
        counts[platform] += 1;
        return { kind: "published", postId: "demo-" + platform + "-post" };
      },
      async reconcile() { return { kind: "unknown", detail: "Demo only." }; }
    };
  }
  const store = new MemoryStateStore();
  const publisher = new Publisher({ store, adapters: { instagram: adapter("instagram"), threads: adapter("threads") },
    random: () => 0,
    assets: async () => ({ urls: ["https://demo.invalid/01.jpg"],
      manifest: { schemaVersion: 1, id: post.id, inputHash: post.inputHash, sourceCommit: "demo", deploymentId: "demo",
        createdAt: new Date(now).toISOString(), baseUrl: "https://demo.invalid", assets: [] } })
  });
  const env = {
    INSTAGRAM_ACCOUNT_ID: "demo-instagram", THREADS_USER_ID: "demo-threads",
    INSTAGRAM_API_VERSION: "v99.0", THREADS_API_VERSION: "v99.0",
    INSTAGRAM_TOKEN_EXPIRES_AT: "2100-01-01T00:00:00Z", THREADS_TOKEN_EXPIRES_AT: "2100-01-01T00:00:00Z"
  };
  for (const [index, offset] of [0, 120_000, 180_000].entries()) {
    console.log("\n確認 " + (index + 1) + ": " + ["Instagram成功・Threads準備失敗", "Threadsだけ再試行", "両SNSの再送をスキップ"][index]);
    const report = await publisher.run({ action: "publish", posts: [post], nowMs: now + offset, env });
    for (const row of report.rows) console.log(row.platform + ": " + row.status);
  }
  if (counts.instagram !== 1 || counts.threads !== 1) throw new SafeError("Local demo did not preserve one publication per SNS.");
  console.log("\n確認完了：模擬公開は各SNSで1回。再試行による二重投稿はありません。");
}
