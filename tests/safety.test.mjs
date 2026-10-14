import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { Publisher } from "../dist/publisher.js";
import { AssetUnavailableError, preparePagesArtifact, verifyAssetUrl } from "../dist/assets.js";
import { InstagramAdapter, ThreadsAdapter } from "../dist/platforms.js";
import { inspectJpeg, loadPosts } from "../dist/posts.js";
import { initialPostState, MemoryStateStore, StateStoreError } from "../dist/state.js";
import { PlatformRequestError } from "../dist/platforms.js";
import { computeContentHash, parsePublishAt, sha256 } from "../dist/utils.js";
import { GitHubClient, GitHubStateStore } from "../dist/github.js";
import { buildWorkflowDispatchInputs, workflowTrackingUrl, runCli } from "../dist/cli.js";
import { createSample, runLocalDemo } from "../dist/local.js";

const jpegFixtures = new Map();
function makeJpeg(salt = 0) {
  if (jpegFixtures.has(salt)) return Buffer.from(jpegFixtures.get(salt));
  const description = Buffer.from([0, 0x73, 0, 0x52, 0, 0x47, 0, 0x42]);
  const tagSize = 36;
  const profile = Buffer.alloc(144 + tagSize);
  profile.writeUInt32BE(profile.length, 0);
  profile.writeUInt32BE(0x04300000, 8);
  profile.write("RGB ", 16, "ascii");
  profile.write("acsp", 36, "ascii");
  profile.writeUInt32BE(1, 128);
  profile.write("desc", 132, "ascii");
  profile.writeUInt32BE(144, 136);
  profile.writeUInt32BE(tagSize, 140);
  profile.write("mluc", 144, "ascii");
  profile.writeUInt32BE(1, 152);
  profile.writeUInt32BE(12, 156);
  profile.write("enUS", 160, "ascii");
  profile.writeUInt32BE(description.length, 164);
  profile.writeUInt32BE(28, 168);
  description.copy(profile, 172);
  profile[100] = salt;

  const app2 = Buffer.alloc(4 + 14 + profile.length);
  app2[0] = 0xff;
  app2[1] = 0xe2;
  app2.writeUInt16BE(app2.length - 2, 2);
  app2.write("ICC_PROFILE\0", 4, "ascii");
  app2[16] = 1;
  app2[17] = 1;
  profile.copy(app2, 18);

  const rgba = Buffer.alloc(1080 * 1080 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = 127;
    rgba[offset + 1] = 156;
    rgba[offset + 2] = 181;
    rgba[offset + 3] = 255;
  }
  const encoded = jpeg.encode({ width: 1080, height: 1080, data: rgba }, 80).data;
  const result = Buffer.concat([encoded.subarray(0, 2), app2, encoded.subarray(2)]);
  jpegFixtures.set(salt, result);
  return Buffer.from(result);
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "social-publisher-test-"));
  const postsRoot = path.join(root, "posts");
  const id = options.id ?? "test-post";
  const directory = path.join(postsRoot, id);
  await mkdir(directory, { recursive: true });
  const images = options.images ?? ["01.jpg"];
  for (const name of images) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.jpe?g$/i.test(name) && !name.includes("..")) {
      await writeFile(path.join(directory, name), options.imageBytes ?? makeJpeg());
    }
  }
  const input = {
    schemaVersion: 1,
    id,
    enabled: options.enabled ?? true,
    publishAt: options.publishAt ?? "2026-10-06T12:00:00+09:00",
    text: options.text ?? "caption",
    images,
    platforms: options.platforms ?? ["instagram", "threads"],
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.extra ?? {})
  };
  await writeFile(path.join(directory, "post.json"), JSON.stringify(input, null, 2));
  const loaded = await loadPosts(postsRoot);
  return { root, postsRoot, directory, post: loaded.posts.find((post) => post.id === id), loaded };
}

async function withFixture(options, run) {
  const value = await fixture(options);
  try {
    await run(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

function makeAdapter(platform, custom = {}) {
  const adapter = {
    platform,
    validateConfiguration() {},
    async checkPublishingQuota() { return { usage: 0, total: 10, durationSeconds: 86400 }; },
    async prepare(_post, state, _urls, checkpoint) {
      const containerId = state.containerId ?? platform + "-container";
      if (!state.containerId) await checkpoint({ containerId, childContainerIds: [] });
      return { containerId, childContainerIds: [...state.childContainerIds], ready: true, status: "FINISHED" };
    },
    async publish() {
      return { kind: "published", postId: platform + "-published-id" };
    },
    async reconcile() {
      return { kind: "unknown", detail: "not verified" };
    }
  };
  return Object.assign(adapter, custom);
}

function futureTokenEnv() {
  return {
    INSTAGRAM_ACCOUNT_ID: "ig-account",
    THREADS_USER_ID: "threads-user",
    INSTAGRAM_TOKEN_EXPIRES_AT: "2100-01-01T00:00:00Z",
    THREADS_TOKEN_EXPIRES_AT: "2100-01-01T00:00:00Z",
    INSTAGRAM_API_VERSION: "v99.0",
    THREADS_API_VERSION: "v99.0",
    ASSET_MODE: "pages"
  };
}

function makePublisher(store, adapters, extra = {}) {
  return new Publisher({
    store,
    adapters,
    assets: async (post) => ({
      manifest: { schemaVersion: 1, id: post.id, inputHash: post.inputHash, sourceCommit: "test", deploymentId: "test", createdAt: "2026-10-07T00:00:00Z", baseUrl: "https://assets.example", assets: [] },
      urls: post.resolvedImages.map((image) => "https://assets.example/" + post.id + "/" + image.sha256 + "/" + image.name)
    }),
    random: () => 0,
    ...extra
  });
}

function responseWithUrl(url, body, headers = {}) {
  const response = new Response(body, { status: 200, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("publishAt compares explicit offsets in UTC and rejects impossible calendar dates", () => {
  assert.equal(parsePublishAt("2026-10-10T20:00:00+09:00"), Date.parse("2026-10-10T11:00:00Z"));
  assert.throws(() => parsePublishAt("2026-02-30T20:00:00+09:00"), /calendar date/);
  assert.throws(() => parsePublishAt("2026-10-10T20:00:00"), /explicit/);
});

test("both Meta adapters read per-account quota and reject unverified responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [adapter, host, edge] of [
      [new InstagramAdapter("test-token", "v99.0"), "graph.instagram.com", "content_publishing_limit"],
      [new ThreadsAdapter("test-token", "v99.0"), "graph.threads.net", "threads_publishing_limit"]
    ]) {
      globalThis.fetch = async (url, init) => {
        const parsed = new URL(url);
        assert.equal(parsed.host, host);
        assert.equal(parsed.pathname, "/v99.0/account/" + edge);
        assert.equal(parsed.searchParams.get("fields"), "quota_usage,config");
        assert.equal(init.method, "GET");
        assert.equal(parsed.searchParams.has("access_token"), false);
        return Response.json({ data: [{ quota_usage: 2, config: { quota_total: 7, quota_duration: 3600 } }] });
      };
      assert.deepEqual(await adapter.checkPublishingQuota("account"), { usage: 2, total: 7, durationSeconds: 3600 });
      for (const body of [null, {}, { data: [] }, { data: [null] },
        { data: [{ quota_usage: "0", config: { quota_total: 7, quota_duration: 3600 } }] },
        { data: [{ quota_usage: 0, config: { quota_total: 7 } }] },
        { data: [{ quota_usage: -1, config: { quota_total: 7, quota_duration: 3600 } }] }]) {
        globalThis.fetch = async () => Response.json(body);
        await assert.rejects(() => adapter.checkPublishingQuota("account"),
          (error) => error instanceof PlatformRequestError && error.retryable && error.detail.stage === "publishing_quota");
      }
      for (const status of [403, 429, 503]) {
        globalThis.fetch = async () => Response.json({ error: { code: 123, message: "private provider detail" } }, { status });
        await assert.rejects(() => adapter.checkPublishingQuota("account"), (error) =>
          error instanceof PlatformRequestError && error.retryable === (status !== 403) && !error.message.includes("private"));
      }
      globalThis.fetch = async () => { throw new Error("private network detail"); };
      await assert.rejects(() => adapter.checkPublishingQuota("account"), (error) => error instanceof PlatformRequestError && error.retryable);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exhausted quota waits before preparation without consuming attempts and preserves partial success", async () => {
  await withFixture({}, async ({ post }) => {
    const store = new MemoryStateStore();
    let blocked = true;
    let prepares = 0;
    let igPublishes = 0;
    let threadPublishes = 0;
    const threads = makeAdapter("threads", {
      async checkPublishingQuota() { return { usage: blocked ? 3 : 0, total: 3, durationSeconds: 86400 }; },
      async prepare(...args) { prepares += 1; return makeAdapter("threads").prepare(...args); },
      async publish() { threadPublishes += 1; return { kind: "published", postId: "thread-post" }; }
    });
    const publisher = makePublisher(store, { threads, instagram: makeAdapter("instagram", {
      async publish() { igPublishes += 1; return { kind: "published", postId: "ig-post" }; }
    }) });
    const nowMs = Date.parse("2026-10-07T00:00:00Z");
    const request = { action: "publish", posts: [post], nowMs, env: futureTokenEnv() };
    const first = await publisher.run(request);
    assert.ok(first.rows.some((row) => row.platform === "threads" && row.detail === "publishing_quota"));
    const waiting = (await store.getPost(post.id)).platforms.threads;
    assert.equal(waiting.attempts, 0);
    assert.equal(waiting.preparationStartedAt, undefined);
    assert.equal(waiting.publishRequestedAt, undefined);
    assert.equal(prepares, 0);
    assert.equal(igPublishes, 1);
    blocked = false;
    await publisher.run({ ...request, nowMs: nowMs + 60_000 });
    assert.equal(prepares, 0);
    await publisher.run({ ...request, nowMs: Date.parse(waiting.nextAttemptAt) });
    assert.equal(threadPublishes, 1);
    assert.equal(igPublishes, 1);
    await publisher.run({ ...request, nowMs: nowMs + 25 * 60_000 });
    assert.equal(threadPublishes, 1);
  });
});

test("quota changing after preparation retains ready container and resumes without consuming attempts", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let reads = 0;
    let created = 0;
    let publishes = 0;
    const threads = makeAdapter("threads", {
      async checkPublishingQuota() { reads += 1; return { usage: reads === 2 ? 10 : 0, total: 10, durationSeconds: 86400 }; },
      async prepare(...args) { if (!args[1].containerId) created += 1; return makeAdapter("threads").prepare(...args); },
      async publish() { publishes += 1; return { kind: "published", postId: "thread-post" }; }
    });
    const publisher = makePublisher(store, { threads, instagram: makeAdapter("instagram") });
    const nowMs = Date.parse("2026-10-07T00:00:00Z");
    const request = { action: "publish", posts: [post], nowMs, env: futureTokenEnv() };
    await publisher.run(request);
    const waiting = (await store.getPost(post.id)).platforms.threads;
    assert.equal(waiting.status, "ready");
    assert.equal(waiting.attempts, 1);
    assert.equal(waiting.containerId, "threads-container");
    assert.equal(waiting.publishRequestedAt, undefined);
    assert.equal(publishes, 0);
    const preview = await publisher.run({ ...request, action: "dry-run", nowMs: nowMs + 60_000 });
    assert.ok(preview.rows.some((row) => row.status === "retry_wait"));
    await publisher.run({ ...request, nowMs: nowMs + 60_000 });
    assert.equal(reads, 2);
    await publisher.run({ ...request, nowMs: Date.parse(waiting.nextAttemptAt) });
    assert.equal((await store.getPost(post.id)).platforms.threads.attempts, 1);
    assert.equal(created, 1);
    assert.equal(publishes, 1);
  });
});

test("quota read errors block preparation and publication with retryable or definite failure", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    for (const retryable of [true, false]) {
      const store = new MemoryStateStore();
      let calls = 0;
      const threads = makeAdapter("threads", {
        async checkPublishingQuota() { throw new PlatformRequestError({ category: "provider", stage: "publishing_quota", message: "unverified" }, retryable); },
        async prepare() { calls += 1; throw new Error("must not prepare"); },
        async publish() { calls += 1; throw new Error("must not publish"); }
      });
      await makePublisher(store, { threads, instagram: makeAdapter("instagram") }).run({
        action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv()
      });
      const state = (await store.getPost(post.id)).platforms.threads;
      assert.equal(state.status, retryable ? "retry_wait" : "failed");
      assert.equal(state.attempts, 0);
      assert.equal(calls, 0);
    }
  });
});

test("bundled sample is disabled, cannot overwrite a post, and demo never accesses the network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "social-publisher-local-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network must not be used by the sample or demo."); };
  try {
    const target = await createSample("sample-copy", root);
    const loaded = await loadPosts(root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.posts[0].enabled, false);
    const before = await readFile(path.join(target, "post.json"), "utf8");
    await assert.rejects(() => createSample("sample-copy", root), /no files were overwritten/);
    assert.equal(await readFile(path.join(target, "post.json"), "utf8"), before);
    await assert.rejects(() => createSample("../escape", root), /Post id/);
    await runLocalDemo();
    assert.equal(await readFile(path.join(target, "post.json"), "utf8"), before);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI preview and npm-consumed dry-run never dispatch a GitHub workflow", async () => {
  await withFixture({}, async ({ postsRoot }) => {
    const originalFetch = globalThis.fetch;
    const originalFlag = process.env.npm_config_dry_run;
    globalThis.fetch = async () => { throw new Error("Dry Run must not access the network."); };
    try {
      await runCli(["preview"], postsRoot);
      process.env.npm_config_dry_run = "true";
      await runCli(["publish"], postsRoot);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalFlag === undefined) delete process.env.npm_config_dry_run;
      else process.env.npm_config_dry_run = originalFlag;
    }
  });
});

test("loader accepts an ordered ten-image carousel and rejects status, traversal, and UTF-16 overflow", async () => {
  await withFixture({ images: Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(2, "0") + ".jpg") }, async ({ loaded, post }) => {
    assert.equal(loaded.errors.length, 0);
    assert.equal(post.resolvedImages.length, 10);
    assert.deepEqual(post.resolvedImages.map((image) => image.name), post.images);
  });
  await withFixture({ extra: { status: "pending" } }, async ({ loaded }) => {
    assert.match(loaded.errors[0], /unsupported field.*status/);
  });
  await withFixture({ images: ["..\\outside.jpg"] }, async ({ loaded }) => {
    assert.match(loaded.errors[0], /direct child/);
  });
  await withFixture({ platforms: ["threads"], overrides: { threads: { text: "😀".repeat(251) } } }, async ({ loaded }) => {
    assert.match(loaded.errors[0], /500 UTF-16/);
  });
});

test("real JPEG fixture decodes, accepts ICC v4 mluc sRGB, and rejects header-only or truncated images", () => {
  const valid = makeJpeg();
  const details = inspectJpeg(valid);
  assert.deepEqual({ width: details.width, height: details.height, srgb: details.srgb }, { width: 1080, height: 1080, srgb: true });
  const scanStart = valid.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scanStart > 0);
  const headerOnly = Buffer.concat([valid.subarray(0, scanStart), Buffer.from([0xff, 0xd9])]);
  assert.throws(() => inspectJpeg(headerOnly), /entropy data is incomplete or corrupt/);
  const truncated = Buffer.concat([valid.subarray(0, valid.length - 40), Buffer.from([0xff, 0xd9])]);
  assert.throws(() => inspectJpeg(truncated), /entropy data is incomplete or corrupt/);
});

test("same post ID skips every successful platform on subsequent runs", async () => {
  await withFixture({}, async ({ post }) => {
    const store = new MemoryStateStore();
    let instagramPublishes = 0;
    let threadsPublishes = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async publish() { instagramPublishes += 1; return { kind: "published", postId: "ig-1" }; } }),
      threads: makeAdapter("threads", { async publish() { threadsPublishes += 1; return { kind: "published", postId: "th-1" }; } })
    });
    const first = await publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv() });
    const second = await publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:01:00Z"), env: futureTokenEnv() });
    assert.equal(first.rows.filter((row) => row.status === "published").length, 2);
    assert.equal(second.rows.filter((row) => row.status === "skip_published").length, 2);
    assert.equal(instagramPublishes, 1);
    assert.equal(threadsPublishes, 1);
  });
});

test("per-run work cap defers remaining due posts and later runs advance past published posts", async () => {
  const posts = await Promise.all(["post-a", "post-b", "post-c"].map((id) => fixture({ id, platforms: ["instagram"] })));
  try {
    const store = new MemoryStateStore();
    let publishes = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async publish() { publishes += 1; return { kind: "published", postId: "ig-" + publishes }; } }),
      threads: makeAdapter("threads")
    });
    const due = Date.parse("2026-10-07T00:00:00Z");
    const first = await publisher.run({ action: "publish", posts: posts.map((item) => item.post), maxPostsPerRun: 2, nowMs: due, env: futureTokenEnv() });
    assert.equal(first.rows.filter((row) => row.status === "published").length, 2);
    assert.ok(first.rows.some((row) => row.postId === "post-c" && row.status === "deferred_limit"));
    const second = await publisher.run({ action: "publish", posts: posts.map((item) => item.post), maxPostsPerRun: 2, nowMs: due + 60_000, env: futureTokenEnv() });
    assert.equal(second.rows.filter((row) => row.status === "published").length, 1);
    assert.equal(publishes, 3);
  } finally {
    await Promise.all(posts.map((item) => rm(item.root, { recursive: true, force: true })));
  }
});

test("partial success retries only the platform with a confirmed preparation failure", async () => {
  await withFixture({}, async ({ post, postsRoot, directory }) => {
    const store = new MemoryStateStore();
    let instagramPublishes = 0;
    let threadsPrepares = 0;
    let threadsPublishes = 0;
    const instagram = makeAdapter("instagram", { async publish() { instagramPublishes += 1; return { kind: "published", postId: "ig-1" }; } });
    const threads = makeAdapter("threads", {
      async prepare(_post, state, _urls, checkpoint) {
        threadsPrepares += 1;
        if (threadsPrepares === 1) throw new PlatformRequestError({ category: "network", stage: "create_container", message: "provider details withheld" }, true);
        return makeAdapter("threads").prepare(_post, state, _urls, checkpoint);
      },
      async publish() { threadsPublishes += 1; return { kind: "published", postId: "th-1" }; }
    });
    const publisher = makePublisher(store, { instagram, threads });
    const due = Date.parse("2026-10-07T00:00:00Z");
    const first = await publisher.run({ action: "publish", posts: [post], nowMs: due, env: futureTokenEnv() });
    assert.ok(first.rows.some((row) => row.platform === "threads" && row.status === "retry_wait"));
    assert.ok(first.rows.some((row) => row.platform === "instagram" && row.status === "published"));
    const inputPath = path.join(directory, "post.json");
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    input.text = "caption changed after a partial success";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const edited = (await loadPosts(postsRoot)).posts[0];
    assert.ok(edited);
    const rejectedEdit = await publisher.run({ action: "publish", posts: [edited], nowMs: due + 60_000, env: futureTokenEnv() });
    assert.ok(rejectedEdit.rows.some((row) => row.status === "content_changed"));
    assert.equal(instagramPublishes, 1);
    assert.equal(threadsPrepares, 1);

    input.text = "caption";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    await writeFile(path.join(directory, "01.jpg"), makeJpeg(1));
    const imageEdited = (await loadPosts(postsRoot)).posts[0];
    assert.ok(imageEdited);
    const rejectedImage = await publisher.run({ action: "publish", posts: [imageEdited], nowMs: due + 60_000, env: futureTokenEnv() });
    assert.ok(rejectedImage.rows.some((row) => row.status === "content_changed"));
    await writeFile(path.join(directory, "01.jpg"), makeJpeg());
    const restored = (await loadPosts(postsRoot)).posts[0];
    assert.ok(restored);
    const changedAccount = await publisher.run({
      action: "publish", posts: [restored], nowMs: due + 60_000,
      env: { ...futureTokenEnv(), THREADS_USER_ID: "different-threads-account" }
    });
    assert.ok(changedAccount.rows.some((row) => row.status === "content_changed"));
    assert.equal(threadsPrepares, 1);
    const resumed = await publisher.run({ action: "publish", posts: [restored], nowMs: due + 120_000, env: futureTokenEnv() });
    assert.equal(resumed.rows.filter((row) => row.status === "published").length, 1);
    assert.equal(instagramPublishes, 1);
    assert.equal(threadsPrepares, 2);
    assert.equal(threadsPublishes, 1);
  });
});

test("temporary image deployment wait permits same-ID input edits before SNS preparation starts", async () => {
  await withFixture({ platforms: ["instagram"] }, async ({ post, postsRoot, directory }) => {
    const store = new MemoryStateStore();
    let available = false;
    let publishes = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async publish() { publishes += 1; return { kind: "published", postId: "ig-same-id" }; } }),
      threads: makeAdapter("threads")
    }, {
      assets: async (currentPost) => {
        if (!available) throw new AssetUnavailableError("Pages deployment is still propagating.");
        return {
          manifest: { schemaVersion: 1, id: currentPost.id, inputHash: currentPost.inputHash, sourceCommit: "test", deploymentId: "test", createdAt: "2026-10-07T00:00:00Z", baseUrl: "https://assets.example", assets: [] },
          urls: currentPost.resolvedImages.map((image) => "https://assets.example/" + image.name)
        };
      }
    });
    const due = Date.parse("2026-10-07T00:00:00Z");
    const first = await publisher.run({ action: "publish", posts: [post], nowMs: due, env: futureTokenEnv() });
    const before = await store.getPost(post.id);
    assert.ok(first.rows.some((row) => row.status === "retry_wait" && row.detail === "asset_not_ready"));
    assert.equal(before.platforms.instagram.attempts, 0);
    assert.equal(before.platforms.instagram.containerId, undefined);

    const inputPath = path.join(directory, "post.json");
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    input.text = "caption corrected while waiting for image delivery";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const edited = (await loadPosts(postsRoot)).posts[0];
    assert.ok(edited);
    available = true;
    const second = await publisher.run({ action: "publish", posts: [edited], nowMs: due + 120_000, env: futureTokenEnv() });
    const after = await store.getPost(post.id);
    assert.ok(second.rows.some((row) => row.status === "published"));
    assert.notEqual(after.contentHash, before.contentHash);
    assert.equal(after.platforms.instagram.status, "published");
    assert.equal(publishes, 1);
    assert.deepEqual(await store.listPostIds(), [post.id]);
  });
});

test("state-store errors during asset resolution abort the run instead of becoming SNS failures", async () => {
  await withFixture({ platforms: ["instagram"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let snsCalls = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async prepare() { snsCalls += 1; throw new Error("unexpected"); }, async publish() { snsCalls += 1; return { kind: "published", postId: "unexpected" }; } }),
      threads: makeAdapter("threads")
    }, { assets: async () => { throw new StateStoreError("mock state read failure"); } });
    await assert.rejects(() => publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv() }), /mock state read failure/);
    assert.equal((await store.getPost(post.id)).platforms.instagram.status, "pending");
    assert.equal(snsCalls, 0);
  });
});

test("a retry_wait before nextAttemptAt does not consume the actionable-post cap", async () => {
  const fixtures = await Promise.all(["post-a", "post-b"].map((id) => fixture({ id, platforms: ["instagram"] })));
  try {
    const store = new MemoryStateStore();
    let available = false;
    let publishes = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async publish() { publishes += 1; return { kind: "published", postId: "ig-" + publishes }; } }),
      threads: makeAdapter("threads")
    }, {
      assets: async (post) => {
        if (!available && post.id === "post-a") throw new AssetUnavailableError("Pages image is not ready.");
        return { manifest: { schemaVersion: 1, id: post.id, inputHash: post.inputHash, sourceCommit: "test", deploymentId: "test", createdAt: "2026-10-07T00:00:00Z", baseUrl: "https://assets.example", assets: [] }, urls: post.resolvedImages.map((image) => "https://assets.example/" + image.name) };
      }
    });
    const due = Date.parse("2026-10-07T00:00:00Z");
    await publisher.run({ action: "publish", posts: [fixtures[0].post], nowMs: due, env: futureTokenEnv() });
    available = true;
    const result = await publisher.run({ action: "publish", posts: fixtures.map((item) => item.post), maxPostsPerRun: 1, nowMs: due + 1_000, env: futureTokenEnv() });
    assert.ok(result.rows.some((row) => row.postId === "post-a" && row.detail === "next_attempt_not_due"));
    assert.ok(result.rows.some((row) => row.postId === "post-b" && row.status === "published"));
    assert.equal(publishes, 1);
  } finally {
    await Promise.all(fixtures.map((item) => rm(item.root, { recursive: true, force: true })));
  }
});

test("failure to persist publish_requested prevents the publish API call", async () => {
  await withFixture({ platforms: ["instagram"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let saveCount = 0;
    store.failureHook = (operation) => {
      if (operation === "save-post" && ++saveCount === 4) throw new Error("storage unavailable");
    };
    let publishes = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async publish() { publishes += 1; return { kind: "published", postId: "ig-1" }; } }),
      threads: makeAdapter("threads")
    });
    await assert.rejects(() => publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv() }));
    assert.equal(publishes, 0);
    assert.equal((await store.getPost(post.id)).platforms.instagram.status, "ready");
  });
});

test("publish timeout becomes unknown and is never blindly sent again", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let publishes = 0;
    let reconciles = 0;
    const threads = makeAdapter("threads", {
      async publish() { publishes += 1; return { kind: "unknown", error: { category: "network", stage: "publish", message: "response unconfirmed" } }; },
      async reconcile() { reconciles += 1; return { kind: "unknown", detail: "unverified" }; }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads });
    const due = Date.parse("2026-10-07T00:00:00Z");
    const first = await publisher.run({ action: "publish", posts: [post], nowMs: due, env: futureTokenEnv() });
    const second = await publisher.run({ action: "publish", posts: [post], nowMs: due + 60_000, env: futureTokenEnv() });
    const state = await store.getPost(post.id);
    assert.ok(first.rows.some((row) => row.status === "unknown"));
    assert.equal(state.platforms.threads.status, "unknown");
    assert.equal(publishes, 1);
    assert.ok(reconciles >= 1);
    assert.ok(second.rows.some((row) => row.status === "unknown" || row.status === "reconcile_only"));
  });
});

test("successful publish followed by state-save failure remains reconcilable without repost", async () => {
  await withFixture({ platforms: ["instagram"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let saveCount = 0;
    store.failureHook = (operation) => {
      if (operation === "save-post" && ++saveCount >= 5) throw new Error("storage unavailable");
    };
    let publishes = 0;
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", {
        async publish() { publishes += 1; return { kind: "published", postId: "ig-1" }; },
        async reconcile() { return { kind: "published", postId: "ig-1", confirmedBy: "verified_container_status" }; }
      }),
      threads: makeAdapter("threads")
    });
    await assert.rejects(() => publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv() }), /saving the result failed/);
    assert.equal((await store.getPost(post.id)).platforms.instagram.status, "publish_requested");
    store.failureHook = undefined;
    await publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:01:00Z"), env: futureTokenEnv() });
    assert.equal((await store.getPost(post.id)).platforms.instagram.status, "published");
    assert.equal((await store.getPost(post.id)).platforms.instagram.confirmedBy, "verified_container_status");
    assert.equal(publishes, 1);
  });
});

test("GitHub state records with unknown status, missing confirmation, or missing ambiguity checkpoint fail before SNS calls", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    const stamp = "2026-10-07T00:00:00.000Z";
    const base = {
      schemaVersion: 1,
      id: post.id,
      inputHash: post.inputHash,
      contentHash: "sha256:" + "a".repeat(64),
      sourceCommit: "a".repeat(40),
      updatedAt: stamp,
      desiredPlatforms: ["threads"],
      publishAt: post.publishAt,
      enabled: true,
      platforms: {
        threads: {
          accountId: "threads-user",
          status: "unknown",
          attempts: 1,
          containerId: "container-1",
          childContainerIds: [],
          containerStatus: "FINISHED",
          preparedAt: stamp,
          publishRequestedAt: stamp,
          publishRunId: "run-1",
          publishRunAttempt: 1,
          recoveryHistory: []
        }
      }
    };
    const badRecords = [
      { ...base, platforms: { threads: { ...base.platforms.threads, status: "mystery" } } },
      { ...base, platforms: { threads: { ...base.platforms.threads, status: "published", postId: "published-1", publishedAt: stamp } } },
      { ...base, platforms: { threads: { ...base.platforms.threads, containerId: undefined } } },
      { ...base, platforms: { threads: { ...base.platforms.threads, status: "failed", lastError: { category: "provider", stage: "prepare", message: "failed" } } } }
    ];
    const originalFetch = globalThis.fetch;
    for (const record of badRecords) {
      let snsCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/git/ref/heads/publisher-state")) return Response.json({ object: { sha: "state-ref" } });
        if (url.pathname.endsWith("/contents/store.json")) return Response.json({
          encoding: "base64",
          content: Buffer.from(JSON.stringify({ schemaVersion: 1, initialized: true, postIds: [post.id] })).toString("base64"),
          sha: "store-sha"
        });
        if (url.pathname.endsWith("/git/trees/state-ref")) return Response.json({
          truncated: false,
          tree: [{ path: "posts/" + post.id + ".json", type: "blob" }]
        });
        if (url.pathname.endsWith("/contents/posts/" + post.id + ".json")) return Response.json({
          encoding: "base64",
          content: Buffer.from(JSON.stringify(record)).toString("base64"),
          sha: "post-sha"
        });
        throw new Error("unexpected mock URL");
      };
      const store = new GitHubStateStore(new GitHubClient({ token: "mock-token", repository: "owner/repo", apiUrl: "https://api.test" }));
      const adapters = {
        instagram: makeAdapter("instagram", { async reconcile() { snsCalls += 1; return { kind: "unknown", detail: "unexpected" }; } }),
        threads: makeAdapter("threads", { async reconcile() { snsCalls += 1; return { kind: "unknown", detail: "unexpected" }; } })
      };
      const publisher = makePublisher(store, adapters);
      try {
        await assert.rejects(() => publisher.run({ action: "publish", posts: [post], nowMs: Date.parse(stamp), env: futureTokenEnv() }), /malformed|confirmation|checkpoint/);
        assert.equal(snsCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });
});

test("GitHub state mutation rereads after a SHA conflict and CAS-saves over the latest record", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    const stamp = "2026-10-07T00:00:00.000Z";
    const accounts = { threads: "threads-user" };
    let remoteRecord = initialPostState(post, computeContentHash(post, accounts), accounts, "a".repeat(40), stamp);
    let recordSha = "record-sha-1";
    const putShas = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/git/ref/heads/publisher-state")) return Response.json({ object: { sha: "state-ref" } });
      if (url.pathname.endsWith("/contents/store.json")) return Response.json({
        encoding: "base64",
        content: Buffer.from(JSON.stringify({ schemaVersion: 1, initialized: true, postIds: [post.id] })).toString("base64"),
        sha: "store-sha"
      });
      if (url.pathname.endsWith("/contents/posts/" + post.id + ".json") && init.method !== "PUT") return Response.json({
        encoding: "base64",
        content: Buffer.from(JSON.stringify(remoteRecord)).toString("base64"),
        sha: recordSha
      });
      if (url.pathname.endsWith("/contents/posts/" + post.id + ".json") && init.method === "PUT") {
        const body = JSON.parse(init.body);
        putShas.push(body.sha);
        if (putShas.length === 1) {
          remoteRecord = { ...remoteRecord, enabled: false, updatedAt: "2026-10-07T00:01:00.000Z" };
          recordSha = "record-sha-2";
          return Response.json({ message: "sha conflict" }, { status: 409 });
        }
        remoteRecord = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
        recordSha = "record-sha-3";
        return Response.json({ content: { sha: recordSha } });
      }
      throw new Error("unexpected mock URL " + url.pathname);
    };
    const store = new GitHubStateStore(new GitHubClient({ token: "mock-token", repository: "owner/repo", apiUrl: "https://api.test" }));
    try {
      const saved = await store.mutatePost(post.id, (current) => ({ ...current, sourceCommit: "b".repeat(40) }));
      assert.deepEqual(putShas, ["record-sha-1", "record-sha-2"]);
      assert.equal(saved.enabled, false);
      assert.equal(saved.sourceCommit, "b".repeat(40));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("GitHub state branch absence and registry read failures fail closed", async () => {
  const originalFetch = globalThis.fetch;
  let mode = "missing-branch";
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/git/ref/heads/publisher-state") && mode === "missing-branch") return new Response("missing", { status: 404 });
    if (url.pathname.endsWith("/git/ref/heads/publisher-state")) return Response.json({ object: { sha: "state-ref" } });
    if (url.pathname.endsWith("/contents/store.json")) return new Response("provider unavailable", { status: 503 });
    throw new Error("unexpected mock URL " + url.pathname);
  };
  const store = new GitHubStateStore(new GitHubClient({ token: "mock-token", repository: "owner/repo", apiUrl: "https://api.test" }));
  try {
    await assert.rejects(() => store.listPostIds(), /State branch is missing/);
    mode = "registry-read-failure";
    await assert.rejects(() => store.listPostIds(), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta reconciliation uses GET on the same container and confirms only matching PUBLISHED status", async () => {
  const adapter = new ThreadsAdapter("mock-access-token", "v99.0");
  const state = {
    accountId: "threads-user",
    apiVersion: "v99.0",
    status: "unknown",
    attempts: 1,
    containerId: "container-4",
    childContainerIds: [],
    containerStatus: "FINISHED",
    preparedAt: "2026-10-07T00:00:00.000Z",
    publishRequestedAt: "2026-10-07T00:00:00.000Z",
    publishRunId: "run-4",
    publishRunAttempt: 1,
    recoveryHistory: []
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    return Response.json({ id: "container-4", status: "PUBLISHED", error_message: null });
  };
  try {
    const confirmed = await adapter.reconcile(state);
    assert.deepEqual(confirmed, { kind: "published", confirmedBy: "verified_container_status" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url.pathname, "/v99.0/container-4");
    assert.equal(calls[0].url.searchParams.get("fields"), "id,status,error_message");
    assert.ok(!calls.some(({ url }) => url.pathname.endsWith("/threads_publish")));

    globalThis.fetch = async () => Response.json({ id: "container-4", status: "FINISHED" });
    assert.equal((await adapter.reconcile(state)).kind, "unknown");
    globalThis.fetch = async () => Response.json({ id: "different-container", status: "PUBLISHED" });
    assert.equal((await adapter.reconcile(state)).kind, "unknown");
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    assert.equal((await adapter.reconcile(state)).kind, "unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registered state missing its record fails closed", async () => {
  await withFixture({ platforms: ["instagram"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    store.breakRegisteredStateForTest(post.id);
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads: makeAdapter("threads") });
    await assert.rejects(() => publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv() }), /disagree|missing/);
  });
});

test("deleted inputs still reconcile unknown state and preserve history", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let publishes = 0;
    let reconciles = 0;
    const threads = makeAdapter("threads", {
      async publish() { publishes += 1; return { kind: "unknown", error: { category: "network", stage: "publish", message: "uncertain" } }; },
      async reconcile() { reconciles += 1; return { kind: "unknown", detail: "still unverified" }; }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads });
    await publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2026-10-07T00:00:00Z"), env: futureTokenEnv() });
    const deletedInputRun = await publisher.run({ action: "publish", posts: [], nowMs: Date.parse("2026-10-07T00:01:00Z"), env: futureTokenEnv() });
    assert.ok(deletedInputRun.rows.some((row) => row.postId === post.id && row.status === "unknown"));
    assert.deepEqual(await store.listPostIds(), [post.id]);
    assert.equal((await store.getPost(post.id)).platforms.threads.status, "unknown");
    assert.equal(publishes, 1);
    assert.ok(reconciles >= 1);
  });
});

test("enabled false stops new posts while unknown history remains reconcilable", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post }) => {
    const store = new MemoryStateStore();
    let publishes = 0;
    let reconciles = 0;
    const threads = makeAdapter("threads", {
      async publish() { publishes += 1; return { kind: "unknown", error: { category: "network", stage: "publish", message: "uncertain" } }; },
      async reconcile() { reconciles += 1; return { kind: "unknown", detail: "still unverified" }; }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads });
    const due = Date.parse("2026-10-07T00:00:00Z");
    await publisher.run({ action: "publish", posts: [post], nowMs: due, env: futureTokenEnv() });
    post.enabled = false;
    const result = await publisher.run({ action: "publish", posts: [post], nowMs: due + 60_000, env: futureTokenEnv() });
    const state = await store.getPost(post.id);
    assert.equal(state.enabled, false);
    assert.equal(state.platforms.threads.status, "unknown");
    assert.equal(publishes, 1);
    assert.ok(reconciles >= 1);
    assert.ok(result.rows.some((row) => row.status === "skip_disabled"));
  });
});

test("future scheduling waits unless --now names exactly one explicit post ID", async () => {
  await withFixture({ platforms: ["instagram"], publishAt: "2099-10-10T20:00:00+09:00" }, async ({ post }) => {
    const store = new MemoryStateStore();
    let prepares = 0;
    const instagram = makeAdapter("instagram", {
      validateConfiguration() { throw new Error("credentials should not be required before the post is due"); },
      async prepare(...args) { prepares += 1; return makeAdapter("instagram").prepare(...args); }
    });
    const publisher = makePublisher(store, { instagram, threads: makeAdapter("threads") });
    const before = await publisher.run({ action: "publish", posts: [post], nowMs: Date.parse("2099-10-10T10:00:00Z"), env: { INSTAGRAM_ACCOUNT_ID: "ig-account" } });
    assert.ok(before.rows.some((row) => row.status === "wait_until_due"));
    assert.equal(prepares, 0);
    assert.deepEqual(await store.listPostIds(), []);
    await assert.rejects(() => publisher.run({ action: "publish", posts: [post], now: true, nowMs: Date.parse("2099-10-10T10:00:00Z"), env: futureTokenEnv() }), /explicit post ID/);
    const onDemand = makePublisher(store, {
      instagram: makeAdapter("instagram", { async prepare(...args) { prepares += 1; return makeAdapter("instagram").prepare(...args); } }),
      threads: makeAdapter("threads")
    });
    await onDemand.run({ action: "publish", posts: [post], postId: post.id, now: true, nowMs: Date.parse("2099-10-10T10:00:00Z"), env: futureTokenEnv() });
    assert.equal(prepares, 1);
  });
});

test("late posts can publish once with ID-scoped --now while published and unknown IDs remain closed", async () => {
  const late = await fixture({ id: "late-now-post", platforms: ["threads"], publishAt: "2026-10-01T00:00:00Z" });
  const uncertain = await fixture({ id: "late-unknown-post", platforms: ["threads"], publishAt: "2026-10-01T00:00:00Z" });
  try {
    const store = new MemoryStateStore();
    const publishCounts = new Map();
    const threads = makeAdapter("threads", {
      async prepare(post, state, _urls, checkpoint) {
        const containerId = "container-" + post.id;
        if (!state.containerId) await checkpoint({ containerId, childContainerIds: [] });
        return { containerId, childContainerIds: [], ready: true, status: "FINISHED" };
      },
      async publish(_accountId, media) {
        const count = (publishCounts.get(media.containerId) ?? 0) + 1;
        publishCounts.set(media.containerId, count);
        if (media.containerId === "container-" + uncertain.post.id) {
          return { kind: "unknown", error: { category: "network", stage: "publish", message: "response uncertain" } };
        }
        return { kind: "published", postId: "published-" + media.containerId };
      },
      async reconcile() { return { kind: "unknown", detail: "no direct confirmation" }; }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads });
    const nowMs = Date.parse("2026-10-07T00:00:00Z");
    const env = { ...futureTokenEnv(), MAX_LATENESS_MINUTES: "1440" };
    const lateResult = await publisher.run({ action: "publish", posts: [late.post], nowMs, env });
    assert.ok(lateResult.rows.some((row) => row.status === "failed" && row.detail === "schedule_late"));
    assert.equal(publishCounts.size, 0);

    const explicitLate = await publisher.run({ action: "publish", posts: [late.post], postId: late.post.id, now: true, nowMs, env });
    assert.ok(explicitLate.rows.some((row) => row.status === "published"));
    const repeatedPublished = await publisher.run({ action: "publish", posts: [late.post], postId: late.post.id, now: true, nowMs: nowMs + 60_000, env });
    assert.ok(repeatedPublished.rows.some((row) => row.status === "skip_published"));
    assert.equal(publishCounts.get("container-" + late.post.id), 1);

    const uncertainLate = await publisher.run({ action: "publish", posts: [uncertain.post], nowMs, env });
    assert.ok(uncertainLate.rows.some((row) => row.status === "failed" && row.detail === "schedule_late"));
    const explicitUncertain = await publisher.run({ action: "publish", posts: [uncertain.post], postId: uncertain.post.id, now: true, nowMs, env });
    assert.ok(explicitUncertain.rows.some((row) => row.status === "unknown"));
    const repeatedUnknown = await publisher.run({ action: "publish", posts: [uncertain.post], postId: uncertain.post.id, now: true, nowMs: nowMs + 60_000, env });
    assert.ok(repeatedUnknown.rows.some((row) => row.status === "unknown" || row.status === "reconcile_only"));
    assert.equal(publishCounts.get("container-" + uncertain.post.id), 1);
    assert.equal((await store.getPost(uncertain.post.id)).platforms.threads.status, "unknown");
  } finally {
    await Promise.all([rm(late.root, { recursive: true, force: true }), rm(uncertain.root, { recursive: true, force: true })]);
  }
});

test("local dry-run makes no state writes, asset checks, or platform calls", async () => {
  await withFixture({}, async ({ post }) => {
    const store = new MemoryStateStore();
    let writes = 0;
    store.failureHook = () => { writes += 1; };
    let platformCalls = 0;
    let assetCalls = 0;
    const adapters = {
      instagram: makeAdapter("instagram", { async prepare() { platformCalls += 1; throw new Error("unexpected"); }, async publish() { platformCalls += 1; return { kind: "published", postId: "x" }; } }),
      threads: makeAdapter("threads", { async prepare() { platformCalls += 1; throw new Error("unexpected"); }, async publish() { platformCalls += 1; return { kind: "published", postId: "x" }; } })
    };
    const publisher = makePublisher(store, adapters, { assets: async () => { assetCalls += 1; throw new Error("unexpected"); } });
    await publisher.run({ action: "dry-run", posts: [post], env: futureTokenEnv() });
    assert.equal(writes, 0);
    assert.equal(platformCalls, 0);
    assert.equal(assetCalls, 0);
    assert.deepEqual(await store.listPostIds(), []);
  });
});

test("dry-run reflects editability, status, retry time, schedule lateness, and enabled without writes", async () => {
  await withFixture({}, async ({ post, postsRoot, directory }) => {
    const store = new MemoryStateStore();
    const accounts = { instagram: "ig-account", threads: "threads-user" };
    const due = Date.parse("2026-10-07T00:00:00Z");
    const stamp = new Date(due).toISOString();
    const initial = initialPostState(post, computeContentHash(post, accounts), accounts, "a".repeat(40), stamp);
    await store.ensurePost(post, initial);
    let writes = 0;
    let externalCalls = 0;
    let previewing = false;
    store.failureHook = (operation) => { if (previewing && operation === "save-post") writes += 1; };
    const publisher = makePublisher(store, {
      instagram: makeAdapter("instagram", { async prepare() { externalCalls += 1; throw new Error("unexpected"); } }),
      threads: makeAdapter("threads", { async prepare() { externalCalls += 1; throw new Error("unexpected"); } })
    }, { assets: async () => { externalCalls += 1; throw new Error("unexpected"); } });
    const env = { ...futureTokenEnv(), MAX_LATENESS_MINUTES: "1440" };
    const runDryRun = async (posts, nowMs) => {
      previewing = true;
      try {
        return await publisher.run({ action: "dry-run", posts, nowMs, env });
      } finally {
        previewing = false;
      }
    };

    const inputPath = path.join(directory, "post.json");
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    input.text = "edited while SNS preparation has not started";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const edited = (await loadPosts(postsRoot)).posts[0];
    assert.ok(edited);
    const editable = await runDryRun([edited], due);
    assert.ok(editable.rows.every((row) => row.status === "would_prepare"));

    input.text = "caption";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const restored = (await loadPosts(postsRoot)).posts[0];
    assert.ok(restored);
    await store.mutatePost(post.id, (current) => ({
      ...current,
      platforms: {
        instagram: { ...current.platforms.instagram, status: "preparing", attempts: 1, apiVersion: "v99.0", preparationStartedAt: stamp },
        threads: { ...current.platforms.threads, status: "retry_wait", attempts: 1, nextAttemptAt: new Date(due + 60_000).toISOString(), lastError: { category: "provider", stage: "create_container", message: "waiting" } }
      }
    }));
    const waiting = await runDryRun([restored], due);
    assert.ok(waiting.rows.some((row) => row.platform === "instagram" && row.status === "would_resume_preparation"));
    assert.ok(waiting.rows.some((row) => row.platform === "threads" && row.status === "retry_wait" && row.detail === "next_attempt_not_due:" + new Date(due + 60_000).toISOString()));

    await store.mutatePost(post.id, (current) => ({
      ...current,
      platforms: {
        instagram: { ...current.platforms.instagram, status: "ready", containerId: "ig-ready", preparedAt: stamp },
        threads: { ...current.platforms.threads, attempts: 5, nextAttemptAt: stamp }
      }
    }));
    const ready = await runDryRun([restored], due);
    assert.ok(ready.rows.some((row) => row.platform === "instagram" && row.status === "would_publish"));
    assert.ok(ready.rows.some((row) => row.platform === "threads" && row.status === "failed" && row.detail === "attempt_limit"));

    const disabled = await runDryRun([{ ...restored, enabled: false }], due);
    assert.ok(disabled.rows.every((row) => row.status === "skip_disabled"));

    await store.mutatePost(post.id, (current) => ({ ...current, platforms: initial.platforms }));
    const latePost = { ...restored, publishAt: "2026-10-04T00:00:00.000Z", publishAtMs: Date.parse("2026-10-04T00:00:00.000Z") };
    const late = await runDryRun([latePost], due);
    assert.ok(late.rows.every((row) => row.status === "requires_now" && row.detail === "schedule_late"));
    const futurePost = { ...restored, publishAt: "2026-10-07T01:00:00.000Z", publishAtMs: due + 60 * 60_000 };
    const future = await runDryRun([futurePost], due);
    assert.ok(future.rows.every((row) => row.status === "wait_until_due"));
    assert.equal(writes, 0);
    assert.equal(externalCalls, 0);
  });
});

test("dry-run and publish use the same sorted priority under the per-run limit", async () => {
  const first = await fixture({ id: "dry-run-first", platforms: ["threads"], publishAt: "2026-10-06T13:00:00+09:00" });
  const second = await fixture({ id: "dry-run-second", platforms: ["threads"], publishAt: "2026-10-06T20:00:00+09:00" });
  try {
    const store = new MemoryStateStore();
    const env = futureTokenEnv();
    for (const item of [first, second]) {
      const accounts = { threads: "threads-user" };
      const initial = initialPostState(item.post, computeContentHash(item.post, accounts), accounts, "a".repeat(40), "2026-10-07T00:00:00.000Z");
      await store.ensurePost(item.post, initial);
    }
    const published = [];
    const threads = makeAdapter("threads", {
      async prepare(post, state, _urls, checkpoint) {
        const containerId = "container-" + post.id;
        if (!state.containerId) await checkpoint({ containerId, childContainerIds: [] });
        return { containerId, childContainerIds: [], ready: true, status: "FINISHED" };
      },
      async publish(_accountId, media) {
        published.push(media.containerId);
        return { kind: "published", postId: "published-" + media.containerId };
      }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads });
    const reversed = [second.post, first.post];
    const result = await publisher.run({
      action: "dry-run", posts: reversed, maxPostsPerRun: 1,
      nowMs: Date.parse("2026-10-07T00:00:00Z"), env
    });
    assert.ok(result.rows.some((row) => row.postId === first.post.id && row.status === "would_prepare"));
    assert.ok(result.rows.some((row) => row.postId === second.post.id && row.status === "deferred_limit"));

    const actual = await publisher.run({
      action: "publish", posts: reversed, maxPostsPerRun: 1,
      nowMs: Date.parse("2026-10-07T00:00:00Z"), env
    });
    assert.deepEqual(published, ["container-" + first.post.id]);
    assert.ok(actual.rows.some((row) => row.postId === first.post.id && row.status === "published"));
    assert.ok(actual.rows.some((row) => row.postId === second.post.id && row.status === "deferred_limit"));
  } finally {
    await Promise.all([rm(first.root, { recursive: true, force: true }), rm(second.root, { recursive: true, force: true })]);
  }
});

test("dry-run permits the fifth attempt to continue when preparation is already in progress or ready", async () => {
  const preparing = await fixture({ id: "dry-run-preparing-fifth", platforms: ["threads"] });
  const ready = await fixture({ id: "dry-run-ready-fifth", platforms: ["threads"] });
  try {
    const store = new MemoryStateStore();
    const accounts = { threads: "threads-user" };
    const stamp = "2026-10-07T00:00:00.000Z";
    for (const item of [preparing, ready]) {
      await store.ensurePost(item.post, initialPostState(item.post, computeContentHash(item.post, accounts), accounts, "a".repeat(40), stamp));
    }
    await store.mutatePost(preparing.post.id, (current) => ({
      ...current,
      platforms: { ...current.platforms, threads: { ...current.platforms.threads, status: "preparing", attempts: 5, apiVersion: "v99.0", preparationStartedAt: stamp } }
    }));
    await store.mutatePost(ready.post.id, (current) => ({
      ...current,
      platforms: { ...current.platforms, threads: { ...current.platforms.threads, status: "ready", attempts: 5, apiVersion: "v99.0", containerId: "ready-container", preparedAt: stamp, preparationStartedAt: stamp } }
    }));
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads: makeAdapter("threads") });
    const result = await publisher.run({
      action: "dry-run", posts: [ready.post, preparing.post], nowMs: Date.parse(stamp), env: futureTokenEnv()
    });
    assert.ok(result.rows.some((row) => row.postId === preparing.post.id && row.status === "would_resume_preparation"));
    assert.ok(result.rows.some((row) => row.postId === ready.post.id && row.status === "would_publish"));
    assert.ok(result.rows.every((row) => row.detail !== "attempt_limit"));
  } finally {
    await Promise.all([rm(preparing.root, { recursive: true, force: true }), rm(ready.root, { recursive: true, force: true })]);
  }
});

test("recovery resets exhausted attempts, retains audit history, and keeps content frozen", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post, postsRoot, directory }) => {
    const store = new MemoryStateStore();
    let prepares = 0;
    const adapter = makeAdapter("threads", {
      async prepare(...args) { prepares += 1; return makeAdapter("threads").prepare(...args); },
      async publish() { return { kind: "unknown", error: { category: "network", stage: "publish", message: "uncertain" } }; }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads: adapter });
    const due = Date.parse("2026-10-07T00:00:00Z");
    await publisher.run({ action: "publish", posts: [post], nowMs: due, env: futureTokenEnv() });
    await assert.rejects(() => publisher.run({
      action: "retry-failed", posts: [post], postId: post.id,
      recovery: { platform: "threads", evidence: "2026-10-07Z attempted failed-only retry" },
      nowMs: due + 500, env: futureTokenEnv()
    }), /definite failed result/);
    await assert.rejects(() => publisher.run({
      action: "recover", posts: [post], postId: post.id,
      recovery: { platform: "threads", evidence: "Bearer abcdefghijklmnopqrstuvwxyz1234567890" },
      nowMs: due + 1000, env: futureTokenEnv()
    }), /credential material/);
    await store.mutatePost(post.id, (current) => ({
      ...current,
      platforms: { ...current.platforms, threads: { ...current.platforms.threads, attempts: 5 } }
    }));
    await publisher.run({
      action: "recover", posts: [post], postId: post.id,
      recovery: { platform: "threads", evidence: "2026-10-07Z account checked; no matching post" },
      nowMs: due + 2000, env: futureTokenEnv()
    });
    const state = (await store.getPost(post.id)).platforms.threads;
    assert.equal(state.status, "pending");
    assert.equal(state.attempts, 0);
    assert.equal(state.recoveryHistory.length, 1);
    assert.equal(state.recoveryHistory[0].previousAttempts, 5);
    assert.equal(state.recoveryHistory[0].previousContainerId, "threads-container");
    assert.ok(state.preparationStartedAt);

    const inputPath = path.join(directory, "post.json");
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    input.text = "caption changed after recovering an unknown result";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const edited = (await loadPosts(postsRoot)).posts[0];
    assert.ok(edited);
    const blockedEdit = await publisher.run({ action: "publish", posts: [edited], nowMs: due + 3000, env: futureTokenEnv() });
    assert.ok(blockedEdit.rows.some((row) => row.status === "content_changed"));
    assert.equal(prepares, 1);

    const resumed = makePublisher(store, {
      instagram: makeAdapter("instagram"),
      threads: makeAdapter("threads", { async publish() { return { kind: "published", postId: "recovered-publish" }; } })
    });
    // Restore the original, verified content before testing that the confirmed recovery can resume.
    input.text = "caption";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const original = (await loadPosts(postsRoot)).posts[0];
    assert.ok(original);
    const resumedResult = await resumed.run({ action: "publish", posts: [original], nowMs: due + 4000, env: futureTokenEnv() });
    assert.ok(resumedResult.rows.some((row) => row.status === "published"));
    assert.equal((await store.getPost(post.id)).platforms.threads.attempts, 1);
  });
});

test("retry-failed explicitly resumes only a confirmed pre-publish failure", async () => {
  await withFixture({ platforms: ["threads"] }, async ({ post, postsRoot, directory }) => {
    const store = new MemoryStateStore();
    let prepares = 0;
    let publishes = 0;
    const failing = makeAdapter("threads", {
      async prepare() {
        prepares += 1;
        throw new PlatformRequestError({ category: "provider", stage: "create_container", httpStatus: 400, message: "preparation rejected" }, false);
      }
    });
    const publisher = makePublisher(store, { instagram: makeAdapter("instagram"), threads: failing });
    const due = Date.parse("2026-10-07T00:00:00Z");
    const first = await publisher.run({ action: "publish", posts: [post], nowMs: due, env: futureTokenEnv() });
    assert.ok(first.rows.some((row) => row.platform === "threads" && row.status === "failed"));
    await store.mutatePost(post.id, (current) => ({
      ...current,
      platforms: { ...current.platforms, threads: { ...current.platforms.threads, attempts: 5 } }
    }));
    const retried = await publisher.run({
      action: "retry-failed", posts: [post], postId: post.id,
      recovery: { platform: "threads", evidence: "2026-10-07Z container creation failed before publish request" },
      nowMs: due + 1_000, env: futureTokenEnv()
    });
    const checkpoint = (await store.getPost(post.id)).platforms.threads;
    assert.ok(retried.rows.some((row) => row.status === "pending"));
    assert.equal(checkpoint.status, "pending");
    assert.equal(checkpoint.attempts, 0);
    assert.equal(checkpoint.recoveryHistory.length, 1);
    assert.equal(checkpoint.recoveryHistory[0].previousAttempts, 5);
    assert.ok(checkpoint.preparationStartedAt);
    assert.equal(prepares, 1);

    // Older records may not have the sticky timestamp. Retained history still proves preparation started.
    await store.mutatePost(post.id, (current) => ({
      ...current,
      platforms: { ...current.platforms, threads: { ...current.platforms.threads, preparationStartedAt: undefined, apiVersion: undefined } }
    }));
    const inputPath = path.join(directory, "post.json");
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    input.text = "caption changed after retry-failed";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const edited = (await loadPosts(postsRoot)).posts[0];
    assert.ok(edited);
    const editedResult = await publisher.run({ action: "publish", posts: [edited], nowMs: due + 1500, env: futureTokenEnv() });
    assert.ok(editedResult.rows.some((row) => row.status === "content_changed"));
    assert.equal(prepares, 1);

    const ready = makePublisher(store, {
      instagram: makeAdapter("instagram"),
      threads: makeAdapter("threads", { async publish() { publishes += 1; return { kind: "published", postId: "thread-post-1" }; } })
    });
    input.text = "caption";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const restored = (await loadPosts(postsRoot)).posts[0];
    assert.ok(restored);
    await ready.run({ action: "publish", posts: [restored], nowMs: due + 2_000, env: futureTokenEnv() });
    assert.equal(publishes, 1);
  });
});

test("Threads carousel checkpoints child IDs in order and does not publish during preparation", async () => {
  await withFixture({ platforms: ["threads"], images: ["01.jpg", "02.jpg", "03.jpg"] }, async ({ post }) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    let nextId = 1;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "GET") return Response.json({ id: "parent-4", status: "FINISHED", error_message: null });
      const id = nextId <= 3 ? "child-" + nextId++ : "parent-4";
      return Response.json({ id });
    };
    try {
      const adapter = new ThreadsAdapter("test-token", "v99.0");
      const checkpoints = [];
      const prepared = await adapter.prepare(post, { accountId: "threads-user", status: "preparing", attempts: 1, childContainerIds: [], recoveryHistory: [] },
        post.resolvedImages.map((image) => "https://assets.example/" + image.name), async (progress) => checkpoints.push(progress));
      assert.equal(prepared.ready, true);
      assert.deepEqual(prepared.childContainerIds, ["child-1", "child-2", "child-3"]);
      assert.deepEqual(checkpoints.slice(0, 3).map((item) => item.childContainerIds.at(-1)), ["child-1", "child-2", "child-3"]);
      const parentBody = new URLSearchParams(calls[3].init.body);
      assert.equal(parentBody.get("children"), "child-1,child-2,child-3");
      assert.ok(!calls.some(({ url }) => url.pathname.endsWith("/threads_publish")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Threads carousel resumes from child checkpoints without recreating saved children", async () => {
  await withFixture({ platforms: ["threads"], images: ["01.jpg", "02.jpg", "03.jpg"] }, async ({ post }) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "GET") return Response.json({ id: "parent-resumed", status: "FINISHED", error_message: null });
      const values = new URLSearchParams(init.body);
      return Response.json({ id: values.get("media_type") === "CAROUSEL" ? "parent-resumed" : "child-3" });
    };
    try {
      const adapter = new ThreadsAdapter("test-token", "v99.0");
      const checkpoints = [];
      const prepared = await adapter.prepare(post, {
        accountId: "threads-user", status: "preparing", attempts: 2, apiVersion: "v99.0",
        preparationStartedAt: "2026-10-07T00:00:00Z", childContainerIds: ["child-1", "child-2"], recoveryHistory: []
      }, post.resolvedImages.map((image) => "https://assets.example/" + image.name), async (progress) => checkpoints.push(progress));
      assert.equal(prepared.ready, true);
      assert.deepEqual(prepared.childContainerIds, ["child-1", "child-2", "child-3"]);
      const childCreates = calls.filter(({ init }) => init.method === "POST" && new URLSearchParams(init.body).get("is_carousel_item") === "true");
      assert.equal(childCreates.length, 1);
      assert.equal(new URLSearchParams(childCreates[0].init.body).get("image_url"), "https://assets.example/03.jpg");
      const carouselCreate = calls.find(({ init }) => init.method === "POST" && new URLSearchParams(init.body).get("media_type") === "CAROUSEL");
      assert.ok(carouselCreate);
      assert.equal(new URLSearchParams(carouselCreate.init.body).get("children"), "child-1,child-2,child-3");
      assert.deepEqual(checkpoints[0].childContainerIds, ["child-1", "child-2", "child-3"]);
      assert.ok(!calls.some(({ url }) => url.pathname.endsWith("/threads_publish")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("public image hash mismatch is rejected", async () => {
  const expected = makeJpeg(0);
  const different = makeJpeg(1);
  assert.equal(expected.length, different.length);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => responseWithUrl(String(url), different, { "content-type": "image/jpeg" });
  try {
    await assert.rejects(() => verifyAssetUrl("https://assets.example/image.jpg", sha256(expected), expected.length), /content hash/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public image verification treats HTTP 404 as delivery wait and rejects HTML bodies", async () => {
  const valid = makeJpeg();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("not deployed", { status: 404 });
    await assert.rejects(() => verifyAssetUrl("https://assets.example/image.jpg", sha256(valid), valid.length), AssetUnavailableError);
    globalThis.fetch = async (url) => responseWithUrl(String(url), "<html>not an image</html>", { "content-type": "text/html" });
    await assert.rejects(() => verifyAssetUrl("https://assets.example/image.jpg", sha256(valid), valid.length), /not image\/jpeg/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pages artifacts retain old immutable image URLs after inputs change or disappear", async () => {
  await withFixture({ id: "current-post", platforms: ["threads"] }, async ({ postsRoot, post, root }) => {
    const oldBytes = makeJpeg(1);
    const oldEntry = { name: "old.jpg", url: "https://old-pages.example/archive/" + sha256(oldBytes) + "/old.jpg", sha256: sha256(oldBytes), size: oldBytes.length };
    const previous = { schemaVersion: 1, id: "archive", inputHash: "old", sourceCommit: "old", deploymentId: "old", createdAt: "2026-10-01T00:00:00Z", baseUrl: "https://old-pages.example", assets: [oldEntry], retainedAssets: [] };
    const output = path.join(root, "site");
    const pending = path.join(root, "pending.json");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => responseWithUrl(String(url), oldBytes, { "content-type": "image/jpeg" });
    try {
      const result = await preparePagesArtifact(postsRoot, output, pending, [previous]);
      assert.equal(result.validCount, 1);
      const archived = await readFile(path.join(output, "archive", oldEntry.sha256, "old.jpg"));
      assert.equal(sha256(archived), oldEntry.sha256);
      const manifest = JSON.parse(await readFile(pending, "utf8"));
      assert.equal(manifest.manifests[0].id, post.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("asset state keeps prior URLs when a post's image manifest is replaced", async () => {
  const store = new MemoryStateStore();
  const oldManifest = { schemaVersion: 1, id: "archive", inputHash: "old", sourceCommit: "old", deploymentId: "old", createdAt: "2026-10-01T00:00:00Z", baseUrl: "https://assets.example", assets: [{ name: "old.jpg", url: "https://assets.example/old.jpg", sha256: "a".repeat(64), size: 100 }] };
  const newManifest = { ...oldManifest, inputHash: "new", assets: [{ name: "new.jpg", url: "https://assets.example/new.jpg", sha256: "b".repeat(64), size: 101 }] };
  await store.saveAssetManifest(oldManifest);
  await store.saveAssetManifest(newManifest);
  const saved = await store.getAssetManifest("archive");
  assert.deepEqual(saved.assets.map((asset) => asset.url), ["https://assets.example/new.jpg"]);
  assert.deepEqual(saved.retainedAssets.map((asset) => asset.url), ["https://assets.example/old.jpg"]);
  assert.equal((await store.listAssetManifests()).length, 1);
});

test("workflow jobs check out one immutable source snapshot and serialize state updates", async () => {
  const prepare = await readFile(new URL("../.github/workflows/prepare-assets.yml", import.meta.url), "utf8");
  const publish = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.equal((prepare.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length, 4);
  assert.match(prepare, /github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(prepare, /upload-pages-artifact/);
  assert.match(prepare, /deploy-pages/);
  assert.match(cli, /source_commit: sourceCommit/);
  assert.match(publish, /ref: \$\{\{ inputs\.source_commit \|\| github\.sha \}\}/);
  assert.match(publish, /git rev-parse HEAD/);
  assert.match(publish, /branches\/\$\{branch_encoded\}/);
  assert.match(publish, /checkout_sha" != "\$latest_sha/);
  assert.match(publish, /max-time 20/);
  assert.match(publish, /cancel-in-progress: false/);
  assert.match(publish, /retry-failed/);
});

test("workflow dispatch supplies a valid recovery choice and uses response run URL with 204 fallback", async () => {
  const inputs = buildWorkflowDispatchInputs("publish", {
    id: "test-post", dryRun: false, now: false, confirmNotPublished: false
  }, "a".repeat(40));
  assert.equal(inputs.recovery_platform, "instagram");
  assert.equal(inputs.source_commit, "a".repeat(40));
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/repos/owner/repo/actions/workflows/publish.yml/dispatches");
    requestBody = JSON.parse(init.body);
    return Response.json({
      workflow_run_id: 123,
      run_url: "https://api.github.com/repos/owner/repo/actions/runs/123",
      html_url: "https://github.com/owner/repo/actions/runs/123"
    });
  };
  const client = new GitHubClient({ token: "mock-token", repository: "owner/repo", apiUrl: "https://api.test" });
  try {
    const accepted = await client.dispatchWorkflow("publish.yml", "main", inputs);
    assert.deepEqual(requestBody, { ref: "main", inputs });
    assert.equal(workflowTrackingUrl(accepted, "https://github.com/owner/repo/actions/workflows/publish.yml"), "https://github.com/owner/repo/actions/runs/123");
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const legacy = await client.dispatchWorkflow("publish.yml", "main", inputs);
    assert.equal(legacy, undefined);
    assert.equal(workflowTrackingUrl(legacy, "https://github.com/owner/repo/actions/workflows/publish.yml"), "https://github.com/owner/repo/actions/workflows/publish.yml");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
