import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import jpeg from "jpeg-js";
import { canonicalJson, parsePublishAt, sha256, SafeError } from "./utils.js";
import { PLATFORMS, type Platform, type PostInput, type ResolvedImage, type ResolvedPost } from "./types.js";

const MAX_IMAGE_BYTES = 5_000_000;
const MAX_IMAGES = 10;
const ALLOWED_POST_KEYS = new Set(["schemaVersion", "id", "enabled", "publishAt", "text", "images", "platforms", "overrides"]);

export interface PostLoadResult {
  posts: ResolvedPost[];
  errors: string[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeError(label + " must be an object.");
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new SafeError(label + " contains unsupported field(s): " + unknown.join(", ") + ".");
}

function parseInput(value: unknown, folderId: string): PostInput {
  const object = requireObject(value, "post.json");
  rejectUnknownKeys(object, ALLOWED_POST_KEYS, "post.json");
  if (object.schemaVersion !== 1) throw new SafeError("schemaVersion must be 1.");
  if (typeof object.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(object.id)) {
    throw new SafeError("id must match ^[a-z0-9][a-z0-9-]{0,79}$.");
  }
  if (object.id !== folderId) throw new SafeError("post.json id must match its folder name.");
  if (object.enabled !== undefined && typeof object.enabled !== "boolean") throw new SafeError("enabled must be a boolean.");
  if (typeof object.publishAt !== "string") throw new SafeError("publishAt must be a string.");
  const publishAtMs = parsePublishAt(object.publishAt);
  if (typeof object.text !== "string" || object.text.trim().length === 0) throw new SafeError("text must contain visible characters.");
  if (!Array.isArray(object.images) || object.images.length < 1 || object.images.length > MAX_IMAGES) {
    throw new SafeError("images must contain between 1 and 10 JPEG filenames.");
  }
  const images = object.images.map((image) => {
    if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.jpe?g$/i.test(image) || image.includes("..")) {
      throw new SafeError("images may contain only direct child .jpg or .jpeg filenames.");
    }
    return image;
  });
  const folded = images.map((image) => image.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new SafeError("images contains duplicate filenames.");
  if (!Array.isArray(object.platforms) || object.platforms.length === 0) {
    throw new SafeError("platforms must contain instagram, threads, or both.");
  }
  const platforms: Platform[] = object.platforms.map((platform) => {
    if (typeof platform !== "string" || !PLATFORMS.includes(platform as Platform)) {
      throw new SafeError("platforms contains an unsupported SNS.");
    }
    return platform as Platform;
  });
  if (new Set(platforms).size !== platforms.length) throw new SafeError("platforms contains a duplicate SNS.");
  const overridesObject = object.overrides === undefined ? {} : requireObject(object.overrides, "overrides");
  rejectUnknownKeys(overridesObject, new Set(PLATFORMS), "overrides");
  const overrides: Partial<Record<Platform, { text: string }>> = {};
  for (const [key, rawOverride] of Object.entries(overridesObject)) {
    const platform = key as Platform;
    const override = requireObject(rawOverride, "overrides." + platform);
    rejectUnknownKeys(override, new Set(["text"]), "overrides." + platform);
    if (typeof override.text !== "string" || override.text.trim().length === 0) {
      throw new SafeError("overrides." + platform + ".text must contain visible characters.");
    }
    const limit = platform === "instagram" ? 2_000 : 500;
    if (override.text.length > limit) throw new SafeError("overrides." + platform + ".text exceeds the tool limit of " + limit + " UTF-16 code units.");
    overrides[platform] = { text: override.text };
  }
  for (const platform of platforms) {
    const resolved = overrides[platform]?.text ?? object.text;
    if (resolved.trim().length === 0) throw new SafeError("Resolved " + platform + " text must contain visible characters.");
    const limit = platform === "instagram" ? 2_000 : 500;
    if (resolved.length > limit) throw new SafeError(platform + " text exceeds the tool limit of " + limit + " UTF-16 code units.");
  }
  return {
    schemaVersion: 1,
    id: object.id,
    enabled: object.enabled ?? true,
    publishAt: object.publishAt,
    text: object.text,
    images,
    platforms,
    overrides
  };
}

function parseSrgbIcc(profileParts: Map<number, Buffer>, expectedCount: number): boolean {
  if (profileParts.size !== expectedCount) return false;
  const chunks: Buffer[] = [];
  for (let index = 1; index <= expectedCount; index += 1) {
    const part = profileParts.get(index);
    if (!part) return false;
    chunks.push(part);
  }
  const profile = Buffer.concat(chunks);
  if (profile.length < 132) return false;
  const declaredSize = profile.readUInt32BE(0);
  if (declaredSize < 132 || declaredSize > profile.length || profile.toString("ascii", 16, 20) !== "RGB ") return false;
  const count = profile.readUInt32BE(128);
  if (132 + count * 12 > declaredSize) return false;
  for (let index = 0; index < count; index += 1) {
    const row = 132 + index * 12;
    const signature = profile.toString("ascii", row, row + 4);
    const offset = profile.readUInt32BE(row + 4);
    const size = profile.readUInt32BE(row + 8);
    if (offset + size > declaredSize || size < 12) continue;
    const tag = profile.subarray(offset, offset + size);
    const type = tag.toString("ascii", 0, 4);
    let description = "";
    if (type === "desc" && size >= 16) {
      const length = Math.min(tag.readUInt32BE(8), size - 12);
      description = tag.toString("ascii", 12, 12 + length);
    } else if (type === "mluc" && size >= 16) {
      const records = tag.readUInt32BE(8);
      const recordSize = tag.readUInt32BE(12);
      if (recordSize >= 12 && 16 + records * recordSize <= size) {
        for (let item = 0; item < records; item += 1) {
          const record = 16 + item * recordSize;
          const length = tag.readUInt32BE(record + 4);
          const position = tag.readUInt32BE(record + 8);
          if (position + length <= size && length % 2 === 0) {
            for (let codeUnit = position; codeUnit < position + length; codeUnit += 2) {
              description += String.fromCharCode(tag.readUInt16BE(codeUnit));
            }
          }
        }
      }
    }
    if ((signature === "desc" || signature === "dscm") && /sRGB|IEC\s*61966[- ]2\.1/i.test(description)) return true;
  }
  return false;
}

export function inspectJpeg(bytes: Buffer): { width: number; height: number; srgb: boolean } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new SafeError("Image is not a complete JPEG file.");
  }
  const iccParts = new Map<number, Buffer>();
  let iccCount = 0;
  let width = 0;
  let height = 0;
  let hasScan = false;
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new SafeError("Image contains an invalid JPEG marker.");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) throw new SafeError("Image contains a truncated JPEG marker.");
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new SafeError("Image contains a truncated JPEG segment.");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new SafeError("Image contains a truncated JPEG segment.");
    const dataStart = offset + 2;
    const dataEnd = offset + segmentLength;
    if (marker === 0xda) {
      if (segmentLength < 6 || dataEnd >= bytes.length - 2) throw new SafeError("Image JPEG entropy data is incomplete or corrupt.");
      hasScan = true;
      break;
    }
    if (startOfFrame.has(marker) && segmentLength >= 8) {
      height = bytes.readUInt16BE(dataStart + 1);
      width = bytes.readUInt16BE(dataStart + 3);
    }
    if (marker === 0xe2 && dataEnd - dataStart >= 14 && bytes.toString("ascii", dataStart, dataStart + 12) === "ICC_PROFILE\0") {
      const sequence = bytes[dataStart + 12] ?? 0;
      const count = bytes[dataStart + 13] ?? 0;
      if (sequence < 1 || count < 1 || sequence > count || (iccCount !== 0 && iccCount !== count)) {
        throw new SafeError("Image contains an invalid ICC profile.");
      }
      iccCount = count;
      if (iccParts.has(sequence)) throw new SafeError("Image contains duplicate ICC profile chunks.");
      iccParts.set(sequence, bytes.subarray(dataStart + 14, dataEnd));
    }
    offset = dataEnd;
  }
  if (!hasScan) throw new SafeError("Image JPEG entropy data is incomplete or corrupt.");
  if (!width || !height) throw new SafeError("Image does not contain JPEG dimensions.");
  const srgb = iccCount > 0 && parseSrgbIcc(iccParts, iccCount);
  if (!srgb) throw new SafeError("Image must include an ICC profile that identifies RGB sRGB.");
  try {
    const decoded = jpeg.decode(bytes, { tolerantDecoding: false, maxResolutionInMP: 2, maxMemoryUsageInMB: 128 });
    if (decoded.width !== width || decoded.height !== height) throw new Error("dimension mismatch");
  } catch {
    throw new SafeError("Image JPEG entropy data is incomplete or corrupt.");
  }
  return { width, height, srgb };
}

async function resolveImage(directory: string, name: string): Promise<ResolvedImage> {
  const filePath = path.join(directory, name);
  const info = await lstat(filePath).catch(() => null);
  if (!info) throw new SafeError("Image file is missing: " + name + ".");
  if (info.isSymbolicLink() || !info.isFile()) throw new SafeError("Image must be a regular file, not a link: " + name + ".");
  if (info.size > MAX_IMAGE_BYTES) throw new SafeError("Image exceeds 5,000,000 bytes: " + name + ".");
  const bytes = await readFile(filePath);
  const details = inspectJpeg(bytes);
  if (details.width !== 1080 || details.height !== 1080) {
    throw new SafeError("Image must be 1080×1080 pixels: " + name + ".");
  }
  return {
    name,
    path: filePath,
    sha256: sha256(bytes),
    size: bytes.length,
    width: details.width,
    height: details.height
  };
}

async function loadOne(directory: string, folderId: string): Promise<ResolvedPost> {
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new SafeError("Post directory must be a regular folder.");
  const inputPath = path.join(directory, "post.json");
  const inputInfo = await lstat(inputPath).catch(() => null);
  if (!inputInfo || inputInfo.isSymbolicLink() || !inputInfo.isFile()) throw new SafeError("post.json is missing or is not a regular file.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  } catch {
    throw new SafeError("post.json is not valid JSON.");
  }
  const input = parseInput(decoded, folderId);
  const publishAtMs = parsePublishAt(input.publishAt);
  const resolvedImages = await Promise.all(input.images.map((name) => resolveImage(directory, name)));
  const platformTexts: Record<Platform, string | undefined> = {
    instagram: input.platforms.includes("instagram") ? (input.overrides.instagram?.text ?? input.text) : undefined,
    threads: input.platforms.includes("threads") ? (input.overrides.threads?.text ?? input.text) : undefined
  };
  const inputHash = "sha256:" + sha256(canonicalJson({
    id: input.id,
    platforms: input.platforms,
    texts: platformTexts,
    images: resolvedImages.map(({ name, sha256: imageHash }) => ({ name, sha256: imageHash }))
  }));
  return { ...input, directory, publishAtMs, inputHash, platformTexts, resolvedImages };
}

export async function loadPosts(postsRoot = path.resolve("posts")): Promise<PostLoadResult> {
  const rootInfo = await lstat(postsRoot).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { posts: [], errors: ["posts directory is missing or is not a regular directory."] };
  }
  const entries = await readdir(postsRoot, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name).sort();
  const posts: ResolvedPost[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  for (const folder of folders) {
    const directory = path.join(postsRoot, folder);
    try {
      const post = await loadOne(directory, folder);
      if (seenIds.has(post.id)) throw new SafeError("Duplicate post id.");
      seenIds.add(post.id);
      posts.push(post);
    } catch (error) {
      const message = error instanceof SafeError ? error.message : "Could not read the post input.";
      errors.push(folder + ": " + message);
    }
  }
  return { posts, errors };
}
