import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Platform, ResolvedPost } from "./types.js";

export class SafeError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "SafeError";
  }
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function parsePublishAt(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new SafeError("publishAt must be an ISO timestamp with Z or an explicit ±HH:mm offset.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number((match[7] ?? "").padEnd(3, "0"));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new SafeError("publishAt contains an invalid date or time.");
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millis);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millis
  ) {
    throw new SafeError("publishAt contains a calendar date that does not exist.");
  }
  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetRemainder = Number(match[11]);
    if (offsetHours > 14 || offsetRemainder > 59 || (offsetHours === 14 && offsetRemainder !== 0)) {
      throw new SafeError("publishAt contains an invalid timezone offset.");
    }
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (match[9] === "+" ? 1 : -1);
  }
  return local.getTime() - offsetMinutes * 60_000;
}

export function formatJst(iso: string | number): string {
  const date = typeof iso === "number" ? new Date(iso) : new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date) + " JST";
}

export function computeContentHash(post: ResolvedPost, accountIds: Record<Platform, string | undefined>): string {
  const platforms = post.platforms.map((platform) => ({
    platform,
    accountId: accountIds[platform] ?? "",
    text: post.platformTexts[platform] ?? "",
    images: post.resolvedImages.map((image) => ({ name: image.name, sha256: image.sha256 }))
  }));
  return "sha256:" + sha256(canonicalJson({ id: post.id, platforms }));
}

export function getRunId(): string {
  return process.env.GITHUB_RUN_ID ?? "local";
}

export function getRunAttempt(): number {
  const value = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function getSourceCommit(): string {
  return process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? "local";
}

export function logEvent(event: {
  postId: string;
  platform?: Platform;
  stage: string;
  status: string;
}): void {
  const utc = new Date().toISOString();
  const jst = formatJst(utc);
  const platform = event.platform ? " platform=" + event.platform : "";
  console.log("time_utc=" + utc + " time_jst=" + jst + " run_id=" + getRunId() +
    " post_id=" + event.postId + platform + " stage=" + event.stage + " status=" + event.status);
}

export function secretFromEnvironmentOrGh(): string {
  const direct = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (direct) return direct;
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (!token) throw new Error("empty");
    return token;
  } catch {
    throw new SafeError("GitHub authentication is unavailable. Sign in with GitHub CLI or provide a GitHub Actions token.");
  }
}

export function assertSafePostId(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw new SafeError("Post id must match ^[a-z0-9][a-z0-9-]{0,79}$.");
}

export function validateRecoveryEvidence(value: string): string {
  const evidence = value.trim();
  if (evidence.length < 20 || evidence.length > 1000) {
    throw new SafeError("Recovery evidence must contain between 20 and 1,000 characters.");
  }
  if (/\bBearer\s+\S+|\b(?:access_token|authorization)\s*[:=]|\b(?:IG|EAAG|THAA|gh[pousr]_)\w{15,}/i.test(evidence)) {
    throw new SafeError("Recovery evidence appears to contain credential material; remove it before recording.");
  }
  return evidence;
}
