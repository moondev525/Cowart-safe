import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";

import {
  COWART_STATIC_BUILD_DIR,
  cowartStaticHtml,
} from "./lib/cowart-static-widget.mjs";
import {
  nonEmptyString,
  pageAssetUrl,
  pageDirName,
  pathResolve,
  readCowartCanvasState,
  readCowartPageAsset,
  readCowartSelectionState,
  readCowartViewState,
  resolveCanvasDir,
  resolveCowartPaths,
  saveCowartCanvasSnapshot,
  writeCowartPageAsset,
  writeCowartSelectionState,
  writeCowartViewState,
} from "./lib/canvas-storage.mjs";
import { pluginPath } from "./lib/plugin-root.mjs";
import { inlineWidget, registerWidgetResource } from "./lib/widget-resource.mjs";

const TOOL_RENDER_WIDGET = "render_cowart_canvas_widget";
const TOOL_GET_CANVAS_STATE = "get_cowart_canvas_state";
const TOOL_SAVE_CANVAS_STATE = "save_cowart_canvas_state";
const TOOL_SAVE_SELECTION_STATE = "save_cowart_selection_state";
const TOOL_SAVE_VIEW_STATE = "save_cowart_view_state";
const TOOL_GET_SELECTION = "get_cowart_selection";
const TOOL_INSERT_IMAGE = "insert_cowart_image";
const TOOL_INSERT_HTML_DRAFT = "insert_cowart_html_draft";
const TOOL_SAVE_REFERENCE_IMAGE = "save_cowart_reference_image";
const TOOL_READ_PAGE_ASSET = "read_cowart_page_asset";
const TOOL_DOWNLOAD_FILE = "download_cowart_file";
const TOOL_COPY_IMAGE_TO_CLIPBOARD = "copy_cowart_image_to_clipboard";

const execFileAsync = promisify(execFile);

const PAGE_ID_PREFIX = "page:";
const COWART_WIDGET_URI = "ui://widget/cowart/canvas.html";
const COWART_HTML_DRAFT_URL_ORIGIN = "http://cowart.local";
const DEFAULT_DISPLAY_MODE = "fullscreen";
const COWART_CONNECT_DOMAINS = [];
const COWART_RESOURCE_DOMAINS = ["data:", "blob:"];
const COWART_FRAME_DOMAINS = ["data:", "blob:"];
const MAX_COWART_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_COWART_DIRECT_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_COWART_ENCODED_IMAGE_CHARS = Math.ceil(MAX_COWART_DIRECT_IMAGE_BYTES * 4 / 3) + 4;
const MAX_COWART_IMAGE_DIMENSION = 32_768;
const MAX_COWART_IMAGE_PIXELS = 268_435_456;
const MAX_COWART_HTML_BYTES = 5 * 1024 * 1024;
const MAX_COWART_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_COWART_FILE_NAME_CHARS = 180;

const projectArgsSchema = {
  projectDir: z.string().trim().min(1),
  canvasDir: z.string().trim().optional(),
};

const displayModeSchema = z.enum(["fullscreen", "inline"]);

const pluginManifest = JSON.parse(
  readFileSync(pluginPath(".codex-plugin", "plugin.json"), "utf8"),
);

const server = new McpServer(
  {
    name: pluginManifest.name,
    version: pluginManifest.version,
  },
  {
    instructions:
      "cowart_safe_mcp is Cowart Safe's project-bound canvas MCP server. Every direct tool call requires the active workspace as projectDir. Use render_cowart_canvas_widget only when the user asks to open, reopen, or explicitly refresh the native canvas. Reuse an existing widget for later state, image, and HTML operations.",
  },
);

registerCowartWidget(server);
registerCowartStateTools(server);
registerCowartImageTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function sanitizeFileName(name, fallbackName = "image.png") {
  const rawName = basename(String(name || fallbackName));
  const cleanedExtension = (extname(rawName) || extname(fallbackName) || ".png")
    .replace(/[^a-zA-Z0-9.]+/g, "")
    .slice(0, 16);
  const fallbackExtension = extname(fallbackName).replace(/[^a-zA-Z0-9.]+/g, "");
  const extension = /^\.[a-zA-Z0-9]{1,15}$/u.test(cleanedExtension)
    ? cleanedExtension
    : /^\.[a-zA-Z0-9]{1,15}$/u.test(fallbackExtension)
      ? fallbackExtension
      : ".png";
  const maximumBaseLength = Math.max(1, MAX_COWART_FILE_NAME_CHARS - extension.length);
  let baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[. ]+$/g, "")
    .slice(0, maximumBaseLength);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(baseName)) {
    baseName = `_${baseName}`.slice(0, maximumBaseLength);
  }
  return `${baseName || "image"}${extension}`;
}

function sanitizeDirectoryName(name, fallbackName = "Cowart Export") {
  let directoryName = basename(String(name || fallbackName))
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || fallbackName;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(directoryName)) {
    directoryName = `_${directoryName}`.slice(0, 120);
  }
  return directoryName;
}

function sanitizeHtmlFileName(name, fallbackName = "draft.html") {
  const safeName = sanitizeFileName(name, fallbackName);
  return /\.html?$/i.test(safeName) ? safeName : `${safeName.replace(/\.[^.]+$/, "")}.html`;
}

function sanitizeIdPart(value, fallback = "image") {
  return String(value || fallback)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".htm":
    case ".html":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

function parseDownloadDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?((?:;[^,]*)?),(.*)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("Invalid download dataUrl.");
  const mimeType = nonEmptyString(match[1]) || "application/octet-stream";
  const parameters = match[2] || "";
  const payload = match[3] || "";
  const buffer = /;base64(?:;|$)/i.test(parameters)
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return { buffer, mimeType };
}

async function uniqueFilePath(dir, requestedName) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    try {
      await stat(candidatePath);
      candidate = `${base}-v${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: candidate, filePath: candidatePath };
      throw error;
    }
  }
}

async function uniqueDirectoryPath(dir, requestedName) {
  const safeName = sanitizeDirectoryName(requestedName);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    try {
      await stat(candidatePath);
      candidate = `${safeName}-${counter}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { directoryName: candidate, directoryPath: candidatePath };
      }
      throw error;
    }
  }
}

function uniqueRecordId(store, prefix, seed) {
  const cleanSeed = sanitizeIdPart(seed);
  let candidate = `${prefix}:${cleanSeed}`;
  let counter = 2;
  while (store[candidate]) {
    candidate = `${prefix}:${cleanSeed}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function getRecord(store, id, label) {
  const record = store[id];
  if (!record) throw new Error(`Missing ${label}: ${id}`);
  return record;
}

function findPageIdForShape(store, shapeId) {
  let record = getRecord(store, shapeId, "shape");
  const visited = new Set();
  while (record && !visited.has(record.id)) {
    visited.add(record.id);
    if (record.typeName === "page") return record.id;
    const parentId = record.parentId;
    if (!parentId) break;
    const parent = store[parentId];
    if (parent?.typeName === "page") return parent.id;
    record = parent;
  }
  return null;
}

function getPageShapes(store, pageId) {
  const shapes = [];
  const byParent = new Map();
  for (const record of Object.values(store)) {
    if (record?.typeName !== "shape") continue;
    const siblings = byParent.get(record.parentId) ?? [];
    siblings.push(record);
    byParent.set(record.parentId, siblings);
  }
  const queue = [...(byParent.get(pageId) ?? [])];
  while (queue.length > 0) {
    const shape = queue.shift();
    shapes.push(shape);
    queue.push(...(byParent.get(shape.id) ?? []));
  }
  return shapes;
}

function localBoundsForShape(shape) {
  if (!shape || shape.typeName !== "shape") return null;
  if (shape.type === "arrow") {
    const start = shape.props?.start ?? { x: 0, y: 0 };
    const end = shape.props?.end ?? { x: 0, y: 0 };
    const minX = Math.min(start.x ?? 0, end.x ?? 0);
    const minY = Math.min(start.y ?? 0, end.y ?? 0);
    const maxX = Math.max(start.x ?? 0, end.x ?? 0);
    const maxY = Math.max(start.y ?? 0, end.y ?? 0);
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  const w = finiteNumber(shape.props?.w, shape.type === "text" ? 160 : 1);
  const h = finiteNumber(shape.props?.h, shape.type === "text" ? 40 : 1);
  return { x: 0, y: 0, w, h };
}

function pageBoundsForShape(store, shape) {
  const local = localBoundsForShape(shape);
  if (!local) return null;
  let x = finiteNumber(shape.x, 0) + local.x;
  let y = finiteNumber(shape.y, 0) + local.y;
  let parent = store[shape.parentId];
  const visited = new Set([shape.id]);
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    x += finiteNumber(parent.x, 0);
    y += finiteNumber(parent.y, 0);
    parent = store[parent.parentId];
  }
  return { x, y, w: local.w, h: local.h };
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

function chooseIndex(store, parentId) {
  const siblingIndexes = Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string")
    .map((record) => record.index)
    .sort();
  return generateKeyBetween(siblingIndexes.at(-1) ?? null, null);
}

function firstSelectedShapeId(selection) {
  return selection?.selectedShapes?.length === 1 ? selection.selectedShapes[0]?.id : null;
}

function isAiImageHolderShape(shape) {
  return shape?.typeName === "shape" && shape.meta?.cowartAiImageHolder === true;
}

function isAiDraftHolderShape(shape) {
  return shape?.typeName === "shape" && shape.meta?.cowartAiDraftHolder === true;
}

function isAiSlidesShape(shape) {
  return shape?.typeName === "shape" && shape.meta?.cowartAiSlides === true;
}

function isCowartHtmlDraftShape(shape) {
  return shape?.typeName === "shape" && shape.type === "embed" && (
    shape.meta?.cowartHtmlDraft === true ||
    /^data:text\/html(?:;[^,]*)?,/i.test(String(shape.props?.url || ""))
  );
}

function cowartHtmlDraftVirtualUrl(assetUrl) {
  return `${COWART_HTML_DRAFT_URL_ORIGIN}${assetUrl}`;
}

function cowartHtmlDraftDataUrl(htmlContent) {
  return `data:text/html;base64,${Buffer.from(String(htmlContent || ""), "utf8").toString("base64")}`;
}

function collectDescendantShapeIds(store, shapeId) {
  if (!shapeId) return [];
  const byParent = new Map();
  for (const record of Object.values(store)) {
    if (record?.typeName !== "shape") continue;
    const children = byParent.get(record.parentId) ?? [];
    children.push(record.id);
    byParent.set(record.parentId, children);
  }

  const descendants = [];
  const queue = [...(byParent.get(shapeId) ?? [])];
  const visited = new Set([shapeId]);
  while (queue.length > 0) {
    const childId = queue.shift();
    if (!childId || visited.has(childId)) continue;
    visited.add(childId);
    descendants.push(childId);
    queue.push(...(byParent.get(childId) ?? []));
  }
  return descendants;
}

function choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement }) {
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  let x = anchorBounds ? anchorBounds.x + anchorBounds.w + margin : 0;
  let y = anchorBounds ? anchorBounds.y : 0;

  if (placement === "left" && anchorBounds) x = anchorBounds.x - width - margin;
  if (placement === "below" && anchorBounds) {
    x = anchorBounds.x;
    y = anchorBounds.y + anchorBounds.h + margin;
  }

  const pageShapes = getPageShapes(store, pageId);
  const obstacles = pageShapes
    .filter((shape) => shape.parentId === parentId && shape.id !== anchorShape?.id)
    .map((shape) => pageBoundsForShape(store, shape))
    .filter(Boolean);

  const stepX = Math.max(width + margin, 1);
  const stepY = Math.max(height + margin, 1);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, w: width, h: height };
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, margin / 2))) return candidate;
    if (placement === "below") y += stepY;
    else if (placement === "left") x -= stepX;
    else x += stepX;
  }

  return { x, y, w: width, h: height };
}

function decodeStrictBase64(value, label) {
  const encoded = String(value || "").replace(/\s+/g, "");
  if (!encoded || encoded.length > MAX_COWART_ENCODED_IMAGE_CHARS) {
    throw new Error(`${label} is empty or exceeds the encoded image safety limit.`);
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(encoded)) {
    throw new Error(`${label} is not valid base64.`);
  }
  const canonicalInput = encoded.replace(/=+$/u, "").replace(/-/g, "+").replace(/_/g, "/");
  if (canonicalInput.length % 4 === 1) throw new Error(`${label} is not valid base64.`);
  const paddedInput = canonicalInput.padEnd(canonicalInput.length + ((4 - canonicalInput.length % 4) % 4), "=");
  const buffer = Buffer.from(paddedInput, "base64");
  if (buffer.length > MAX_COWART_DIRECT_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_COWART_DIRECT_IMAGE_BYTES} byte direct-payload safety limit.`);
  }
  const canonicalOutput = buffer.toString("base64").replace(/=+$/u, "");
  if (canonicalInput !== canonicalOutput) throw new Error(`${label} is not canonical base64.`);
  return buffer;
}

function normalizedImageMimeType(value) {
  const mimeType = nonEmptyString(value)?.toLowerCase();
  if (mimeType === "image/jpg" || mimeType === "image/pjpeg") return "image/jpeg";
  if (mimeType === "image/x-png") return "image/png";
  return mimeType;
}

function imageInfoFromBuffer(buffer, label = "image payload") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error(`${label} is empty.`);
  if (buffer.length > MAX_COWART_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_COWART_IMAGE_BYTES} byte safety limit.`);
  }

  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(pngSignature)) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height, mimeType: "image/png", extension: ".png" };
  }

  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (offset + 3 >= buffer.length) break;
      const size = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const width = buffer.readUInt16BE(offset + 7);
        const height = buffer.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) return { width, height, mimeType: "image/jpeg", extension: ".jpg" };
      }
      if (size < 2) break;
      offset += 2 + size;
    }
  }

  if (buffer.length >= 10 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (width > 0 && height > 0) return { width, height, mimeType: "image/gif", extension: ".gif" };
  }

  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        mimeType: "image/webp",
        extension: ".webp",
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        mimeType: "image/webp",
        extension: ".webp",
      };
    }
    if (
      chunk === "VP8 " &&
      buffer.length >= 30 &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
        mimeType: "image/webp",
        extension: ".webp",
      };
    }
  }

  throw new Error(`${label} is not a supported PNG, JPEG, GIF, or WebP bitmap, or its dimensions are invalid.`);
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?((?:;[^,]*)?),(.*)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("Invalid image dataUrl.");
  const declaredMimeType = normalizedImageMimeType(match[1]);
  const parameters = match[2] || "";
  const payload = match[3] || "";
  if (!/;base64(?:;|$)/i.test(parameters)) {
    throw new Error("Cowart image dataUrl must use base64 encoding.");
  }
  const buffer = decodeStrictBase64(payload, "image dataUrl payload");
  return { buffer, declaredMimeType };
}

async function resolveCowartImageInput(args = {}) {
  const imagePath = nonEmptyString(args.imagePath);
  const dataUrl = nonEmptyString(args.dataUrl);
  const dataBase64 = nonEmptyString(args.dataBase64);
  const suppliedSources = [imagePath, dataUrl, dataBase64].filter(Boolean);
  if (suppliedSources.length !== 1) {
    throw new Error("Provide exactly one Cowart image source: imagePath, dataUrl, or dataBase64.");
  }

  let sourceImagePath = null;
  let sourceType = null;
  let buffer = null;
  let declaredMimeType = null;
  if (imagePath) {
    sourceType = "imagePath";
    sourceImagePath = pathResolve(imagePath);
    const sourceStat = await stat(sourceImagePath);
    if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourceImagePath}`);
    if (sourceStat.size > MAX_COWART_IMAGE_BYTES) {
      throw new Error(`imagePath exceeds the ${MAX_COWART_IMAGE_BYTES} byte safety limit.`);
    }
    buffer = await readFile(sourceImagePath);
  } else if (dataUrl) {
    sourceType = "dataUrl";
    ({ buffer, declaredMimeType } = parseImageDataUrl(dataUrl));
  } else {
    sourceType = "dataBase64";
    buffer = decodeStrictBase64(dataBase64, "dataBase64");
  }

  const imageInfo = imageInfoFromBuffer(buffer, sourceImagePath || sourceType);
  if (
    imageInfo.width > MAX_COWART_IMAGE_DIMENSION ||
    imageInfo.height > MAX_COWART_IMAGE_DIMENSION ||
    imageInfo.width * imageInfo.height > MAX_COWART_IMAGE_PIXELS
  ) {
    throw new Error(
      `Cowart image dimensions exceed the safety limit: ${imageInfo.width}x${imageInfo.height}.`,
    );
  }
  const requestedMimeType = normalizedImageMimeType(args.mimeType);
  for (const [label, mimeType] of [["dataUrl", declaredMimeType], ["mimeType", requestedMimeType]]) {
    if (mimeType && mimeType !== imageInfo.mimeType) {
      throw new Error(`${label} declares ${mimeType}, but the bitmap signature is ${imageInfo.mimeType}.`);
    }
  }

  const fallbackName = `cowart-image-${Date.now()}${imageInfo.extension}`;
  const requestedFileName = nonEmptyString(args.fileName) || (sourceImagePath ? basename(sourceImagePath) : fallbackName);
  let fileName = sanitizeFileName(requestedFileName, fallbackName);
  if (mimeTypeForFile(fileName) !== imageInfo.mimeType) {
    fileName = `${fileName.slice(0, fileName.length - extname(fileName).length)}${imageInfo.extension}`;
  }

  return {
    buffer,
    fileName,
    imageInfo,
    sourceImagePath,
    sourceType,
  };
}

async function insertCowartImage(args = {}) {
  const imageInput = await resolveCowartImageInput(args);
  const { buffer: sourceBuffer, fileName: sourceFileName, imageInfo, sourceImagePath, sourceType } = imageInput;

  const canvasState = await readCowartCanvasState(args, { hydrateAssets: false });
  const snapshot = canvasState.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error("No Cowart canvas snapshot exists yet. Open the Cowart widget for the target project and create or save the canvas before inserting images.");
  }

  const store = snapshot.store;
  const { selection } = await readCowartSelectionState(args);
  const { viewState } = await readCowartViewState(args);

  const anchorShapeId = nonEmptyString(args.anchorShapeId) || nonEmptyString(args.sourceShapeId) || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const imageSize = { width: imageInfo.width, height: imageInfo.height };
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  const shouldTargetAiImageHolder = args.matchAnchor !== false && isAiImageHolderShape(anchorShape) && anchorBounds;
  const shouldReplaceAiImageHolder = shouldTargetAiImageHolder && args.replaceAiImageHolder !== false;
  const shouldFillAiImageHolder = shouldTargetAiImageHolder && !shouldReplaceAiImageHolder;
  const matchAnchor = args.matchAnchor !== false && anchorBounds;
  const width = shouldTargetAiImageHolder
    ? anchorBounds.w
    : finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.w : Math.min(imageSize.width, 512));
  const height = shouldTargetAiImageHolder
    ? anchorBounds.h
    : finiteNumber(
      args.displayHeight,
      matchAnchor ? anchorBounds.h : Math.round(width * (imageSize.height / imageSize.width)),
    );
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  let parentId = anchorShape?.parentId && store[anchorShape.parentId] ? anchorShape.parentId : pageId;
  let rotation = 0;
  let bounds = null;

  if (shouldFillAiImageHolder && anchorShape.type === "frame") {
    parentId = anchorShape.id;
    bounds = { x: 0, y: 0, w: width, h: height };
  } else if (shouldTargetAiImageHolder) {
    parentId = anchorShape.parentId && store[anchorShape.parentId] ? anchorShape.parentId : pageId;
    rotation = finiteNumber(anchorShape.rotation, 0);
    bounds = {
      x: finiteNumber(anchorShape.x, 0),
      y: finiteNumber(anchorShape.y, 0),
      w: width,
      h: height,
    };
  } else {
    parentId = anchorShape?.parentId && store[anchorShape.parentId]?.typeName === "page" ? anchorShape.parentId : pageId;
    bounds = choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement });
  }

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(resolveCanvasDir(args), assetsDir)) {
    throw new Error(`Unsafe page assets directory: ${assetsDir}`);
  }
  const { fileName, filePath } = await uniqueFilePath(assetsDir, sourceFileName);
  const recordSeed = sanitizeIdPart(fileName);
  const assetId = uniqueRecordId(store, "asset", recordSeed);
  const shapeId = uniqueRecordId(store, "shape", recordSeed);
  const replacedShapeIds = shouldReplaceAiImageHolder && anchorShapeId
    ? [anchorShapeId, ...collectDescendantShapeIds(store, anchorShapeId)]
    : [];
  const replacedImageShapeIds = replacedShapeIds.filter((id) => store[id]?.typeName === "shape" && store[id]?.type === "image");
  const index = shouldReplaceAiImageHolder && typeof anchorShape?.index === "string"
    ? anchorShape.index
    : chooseIndex(store, parentId);
  const mimeType = imageInfo.mimeType;

  const assetRecord = {
    id: assetId,
    typeName: "asset",
    type: "image",
    props: {
      name: fileName,
      src: pageAssetUrl(pageId, fileName),
      w: imageSize.width,
      h: imageSize.height,
      fileSize: sourceBuffer.length,
      mimeType,
      isAnimated: mimeType === "image/gif",
    },
    meta: args.assetMeta && typeof args.assetMeta === "object" ? args.assetMeta : {},
  };

  const shapeMeta = args.shapeMeta && typeof args.shapeMeta === "object" ? { ...args.shapeMeta } : {};
  if (anchorShapeId && !shapeMeta.cowartAnnotationSourceShapeId) {
    shapeMeta.cowartAnnotationSourceShapeId = anchorShapeId;
  }
  if (shouldTargetAiImageHolder && anchorShapeId && !shapeMeta.cowartGeneratedForAiImageHolder) {
    shapeMeta.cowartGeneratedForAiImageHolder = anchorShapeId;
  }
  if (shouldReplaceAiImageHolder && anchorShapeId) {
    shapeMeta.cowartReplacedAiImageHolder = true;
  }
  if (nonEmptyString(args.annotationScreenshot) && !shapeMeta.cowartAnnotationScreenshot) {
    shapeMeta.cowartAnnotationScreenshot = nonEmptyString(args.annotationScreenshot);
  }

  const shapeRecord = {
    x: bounds.x,
    y: bounds.y,
    rotation,
    isLocked: false,
    opacity: 1,
    meta: shapeMeta,
    id: shapeId,
    type: "image",
    props: {
      w: width,
      h: height,
      assetId,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: nonEmptyString(args.altText) || "Cowart inserted image",
    },
    parentId,
    index,
    typeName: "shape",
  };

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeFile(filePath, sourceBuffer);
    for (const replacedShapeId of replacedShapeIds) {
      delete store[replacedShapeId];
    }
    store[assetId] = assetRecord;
    store[shapeId] = shapeRecord;
    const saveArgs = replacedImageShapeIds.length > 0
      ? {
          ...args,
          acknowledgedImageShapeDeletes: Array.from(new Set([
            ...(Array.isArray(args.acknowledgedImageShapeDeletes) ? args.acknowledgedImageShapeDeletes : []),
            ...replacedImageShapeIds,
          ])),
        }
      : args;
    await saveCowartCanvasSnapshot(saveArgs, snapshot);
  }

  return {
    canvasDir,
    cowartUrl: nonEmptyString(args.cowartUrl),
    pageId,
    parentId,
    anchorShapeId,
    assetId,
    shapeId,
    index,
    sourceImagePath,
    sourceType,
    assetFile: filePath,
    assetUrl: assetRecord.props.src,
    imageSize,
    bounds,
    replacedAiImageHolder: shouldReplaceAiImageHolder,
    replacedShapeIds,
    dryRun: Boolean(args.dryRun),
  };
}

async function insertCowartHtmlDraft(args = {}) {
  const htmlContent = nonEmptyString(args.htmlContent);
  const htmlPath = nonEmptyString(args.htmlPath);
  if (!htmlContent && !htmlPath) {
    throw new Error("htmlContent or htmlPath is required.");
  }

  const sourceHtmlPath = htmlPath ? pathResolve(htmlPath) : null;
  const finalHtml = htmlContent ?? await readFile(sourceHtmlPath, "utf8");
  if (!nonEmptyString(finalHtml)) {
    throw new Error("HTML draft content is empty.");
  }
  if (Buffer.byteLength(finalHtml, "utf8") > MAX_COWART_HTML_BYTES) {
    throw new Error(`HTML draft exceeds the ${MAX_COWART_HTML_BYTES} byte safety limit.`);
  }
  if (sourceHtmlPath) {
    const sourceStat = await stat(sourceHtmlPath);
    if (!sourceStat.isFile()) throw new Error(`htmlPath is not a file: ${sourceHtmlPath}`);
  }

  const canvasState = await readCowartCanvasState(args, { hydrateAssets: false });
  const snapshot = canvasState.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error("No Cowart canvas snapshot exists yet. Open the Cowart widget for the target project and create or save the canvas before inserting HTML drafts.");
  }

  const store = snapshot.store;
  const { selection } = await readCowartSelectionState(args);
  const { viewState } = await readCowartViewState(args);

  const draftShapeId = nonEmptyString(args.draftShapeId) || nonEmptyString(args.anchorShapeId) || firstSelectedShapeId(selection);
  const draftShape = draftShapeId ? getRecord(store, draftShapeId, "AI draft holder shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (draftShape ? findPageIdForShape(store, draftShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const anchorBounds = draftShape ? pageBoundsForShape(store, draftShape) : null;
  const shouldUpdateExistingDraft = args.updateExistingDraft !== false && isCowartHtmlDraftShape(draftShape) && anchorBounds;
  const shouldTargetDraftHolder = args.matchAnchor !== false && isAiDraftHolderShape(draftShape) && anchorBounds;
  const shouldTargetAiSlides = isAiSlidesShape(draftShape);
  const shouldReplaceDraftHolder = shouldTargetDraftHolder && args.replaceDraftHolder !== false;
  const matchAnchor = args.matchAnchor !== false && anchorBounds;
  const width = shouldUpdateExistingDraft || shouldTargetDraftHolder
    ? anchorBounds.w
    : finiteNumber(args.displayWidth, shouldTargetAiSlides ? 1024 : matchAnchor ? anchorBounds.w : 512);
  const height = shouldUpdateExistingDraft || shouldTargetDraftHolder
    ? anchorBounds.h
    : finiteNumber(args.displayHeight, shouldTargetAiSlides ? 576 : matchAnchor ? anchorBounds.h : 683);
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  let parentId = draftShape?.parentId && store[draftShape.parentId] ? draftShape.parentId : pageId;
  let rotation = 0;
  let bounds = null;

  if (shouldTargetAiSlides) {
    const padding = Math.max(0, finiteNumber(draftShape.meta?.cowartAiSlidesPadding, 12));
    const gap = Math.max(0, finiteNumber(draftShape.meta?.cowartAiSlidesGap, 32));
    const slideItems = Object.values(store)
      .filter((record) => record?.typeName === "shape" && record.parentId === draftShape.id)
      .sort((a, b) => String(a.index || "").localeCompare(String(b.index || "")));
    const nextX = slideItems.reduce(
      (cursor, item) => Math.max(cursor, finiteNumber(item.x, padding) + finiteNumber(item.props?.w, 0) + gap),
      padding,
    );
    parentId = draftShape.id;
    rotation = 0;
    bounds = { x: nextX, y: padding, w: width, h: height };
  } else if (shouldUpdateExistingDraft || shouldTargetDraftHolder) {
    parentId = draftShape.parentId && store[draftShape.parentId] ? draftShape.parentId : pageId;
    rotation = finiteNumber(draftShape.rotation, 0);
    bounds = {
      x: finiteNumber(draftShape.x, 0),
      y: finiteNumber(draftShape.y, 0),
      w: width,
      h: height,
    };
  } else {
    parentId = draftShape?.parentId && store[draftShape.parentId]?.typeName === "page" ? draftShape.parentId : pageId;
    bounds = choosePlacement({ store, pageId, parentId, anchorShape: draftShape, width, height, margin, placement });
  }

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) {
    throw new Error(`Unsafe page assets directory: ${assetsDir}`);
  }
  const existingAssetUrl = shouldUpdateExistingDraft
    ? nonEmptyString(draftShape.meta?.cowartHtmlDraftAssetUrl)
    : null;
  const expectedAssetPrefix = `/page-assets/${pageDirName(pageId)}/`;
  let existingFileName = null;
  if (existingAssetUrl?.startsWith(expectedAssetPrefix)) {
    try {
      existingFileName = decodeURIComponent(existingAssetUrl.slice(expectedAssetPrefix.length).split(/[?#]/)[0]);
    } catch (_error) {
      existingFileName = null;
    }
  }
  const shouldForkSharedAsset = Boolean(
    shouldUpdateExistingDraft &&
      existingAssetUrl &&
      Object.values(store).some(
        (record) =>
          record?.id !== draftShape.id &&
          isCowartHtmlDraftShape(record) &&
          nonEmptyString(record.meta?.cowartHtmlDraftAssetUrl) === existingAssetUrl,
      ),
  );
  const requestedName = sanitizeHtmlFileName(
    existingFileName || args.fileName,
    `draft-${Date.now()}.html`,
  );
  const fileTarget = shouldUpdateExistingDraft && existingFileName && !shouldForkSharedAsset
    ? { fileName: requestedName, filePath: join(assetsDir, requestedName) }
    : await uniqueFilePath(assetsDir, requestedName);
  const { fileName, filePath } = fileTarget;
  if (!isSafeChildPath(assetsDir, filePath)) {
    throw new Error(`Unsafe HTML draft file path: ${filePath}`);
  }
  const recordSeed = sanitizeIdPart(fileName, "html-draft");
  const shapeId = shouldUpdateExistingDraft ? draftShape.id : uniqueRecordId(store, "shape", recordSeed);
  const replacedShapeIds = shouldReplaceDraftHolder && draftShapeId
    ? [draftShapeId, ...collectDescendantShapeIds(store, draftShapeId)]
    : [];
  const index = shouldUpdateExistingDraft && typeof draftShape?.index === "string"
    ? draftShape.index
    : shouldReplaceDraftHolder && typeof draftShape?.index === "string"
    ? draftShape.index
    : chooseIndex(store, parentId);
  const assetUrl = pageAssetUrl(pageId, fileName);
  const shapeMeta = args.shapeMeta && typeof args.shapeMeta === "object" ? { ...args.shapeMeta } : {};
  if (shouldTargetDraftHolder && draftShapeId && !shapeMeta.cowartGeneratedForAiDraftHolder) {
    shapeMeta.cowartGeneratedForAiDraftHolder = draftShapeId;
  }
  if (shouldReplaceDraftHolder && draftShapeId) {
    shapeMeta.cowartReplacedAiDraftHolder = true;
  }
  if (shouldTargetAiSlides && draftShapeId && !shapeMeta.cowartAiSlidesParentShapeId) {
    shapeMeta.cowartAiSlidesParentShapeId = draftShapeId;
  }

  const shapeRecord = {
    x: bounds.x,
    y: bounds.y,
    rotation,
    isLocked: false,
    opacity: 1,
    meta: {
      ...(shouldUpdateExistingDraft && draftShape.meta && typeof draftShape.meta === "object" ? draftShape.meta : {}),
      cowartHtmlDraft: true,
      cowartHtmlDraftAssetUrl: assetUrl,
      ...shapeMeta,
    },
    id: shapeId,
    type: "embed",
    props: {
      ...(shouldUpdateExistingDraft && draftShape.props && typeof draftShape.props === "object" ? draftShape.props : {}),
      w: width,
      h: height,
      url: cowartHtmlDraftDataUrl(finalHtml),
    },
    parentId,
    index,
    typeName: "shape",
  };

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeFile(filePath, finalHtml);
    for (const replacedShapeId of replacedShapeIds) {
      delete store[replacedShapeId];
    }
    store[shapeId] = shapeRecord;
    await saveCowartCanvasSnapshot(args, snapshot);
  }

  return {
    canvasDir,
    pageId,
    parentId,
    draftShapeId,
    shapeId,
    index,
    assetFile: filePath,
    assetUrl,
    virtualUrl: cowartHtmlDraftVirtualUrl(assetUrl),
    displayUrlKind: "data:text/html;base64",
    bounds,
    updatedExistingHtmlDraft: Boolean(shouldUpdateExistingDraft),
    forkedSharedHtmlDraftAsset: shouldForkSharedAsset,
    replacedAiDraftHolder: shouldReplaceDraftHolder,
    replacedShapeIds,
    dryRun: Boolean(args.dryRun),
  };
}

async function saveCowartReferenceImage(args = {}) {
  const canvasState = await readCowartCanvasState(args, { hydrateAssets: false });
  const snapshot = canvasState.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error("No Cowart canvas snapshot exists yet. Open the Cowart widget for the target project and create or save the canvas before saving reference images.");
  }

  const store = snapshot.store;
  const { selection } = await readCowartSelectionState(args);
  const { viewState } = await readCowartViewState(args);
  const holderShapeId = nonEmptyString(args.holderShapeId) || nonEmptyString(args.anchorShapeId) || firstSelectedShapeId(selection);
  const holderShape = holderShapeId ? getRecord(store, holderShapeId, "AI image holder shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (holderShape ? findPageIdForShape(store, holderShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId for the reference image.");

  const result = await writeCowartPageAsset(args, {
    pageId,
    fileName: args.fileName,
    dataUrl: args.dataUrl,
    dataBase64: args.dataBase64,
    mimeType: args.mimeType,
  });
  const { projectDir } = resolveCowartPaths(args);

  return {
    ...result,
    projectDir,
    holderShapeId: holderShape?.id ?? holderShapeId ?? null,
    assetPathRelativeToProject: relative(projectDir, result.assetPath),
    assetPathRelativeToCanvas: relative(result.canvasDir, result.assetPath),
  };
}

async function downloadCowartFile(args = {}) {
  const assetUrl = nonEmptyString(args.assetUrl);
  const dataUrl = nonEmptyString(args.dataUrl);
  const dataBase64 = nonEmptyString(args.dataBase64);
  let buffer = null;
  let mimeType = nonEmptyString(args.mimeType) || "application/octet-stream";
  let sourceFileName = null;

  if (assetUrl) {
    const asset = await readCowartPageAsset(args, { assetUrl });
    buffer = Buffer.from(asset.dataBase64, "base64");
    mimeType = asset.mimeType || mimeType;
    sourceFileName = basename(asset.assetPath);
  } else if (dataUrl) {
    const parsed = parseDownloadDataUrl(dataUrl);
    buffer = parsed.buffer;
    mimeType = nonEmptyString(args.mimeType) || parsed.mimeType;
  } else if (dataBase64) {
    buffer = Buffer.from(dataBase64, "base64");
  } else {
    throw new Error("assetUrl, dataUrl, or dataBase64 is required.");
  }

  if (!buffer.length) throw new Error("Cowart download data is empty.");
  if (buffer.length > MAX_COWART_DOWNLOAD_BYTES) {
    throw new Error(`Cowart download data exceeds the ${MAX_COWART_DOWNLOAD_BYTES} byte safety limit.`);
  }

  const downloadsDir = join(homedir(), "Downloads");
  const requestedName = sanitizeFileName(
    nonEmptyString(args.fileName) || sourceFileName,
    `cowart-download-${Date.now()}.png`,
  );
  const requestedDirectoryName = nonEmptyString(args.directoryName);
  const requestedSubdirectory = nonEmptyString(args.subdirectory);
  let directoryName = requestedDirectoryName
    ? sanitizeDirectoryName(requestedDirectoryName)
    : null;
  let exportRoot = directoryName ? join(downloadsDir, directoryName) : downloadsDir;
  if (directoryName && args.uniqueDirectory === true) {
    const uniqueDirectory = await uniqueDirectoryPath(downloadsDir, directoryName);
    directoryName = uniqueDirectory.directoryName;
    exportRoot = uniqueDirectory.directoryPath;
  }
  const targetDir = requestedSubdirectory
    ? join(exportRoot, sanitizeDirectoryName(requestedSubdirectory, "pages"))
    : exportRoot;
  if (!isSafeChildPath(downloadsDir, targetDir) && targetDir !== downloadsDir) {
    throw new Error("Invalid Cowart download directory.");
  }
  await mkdir(targetDir, { recursive: true });
  const { fileName, filePath } = await uniqueFilePath(targetDir, requestedName);
  await writeFile(filePath, buffer);

  return {
    ok: true,
    fileName,
    filePath,
    directoryName,
    directoryPath: exportRoot,
    mimeType,
    fileSize: buffer.length,
  };
}

async function copyCowartImageToClipboard(args = {}) {
  const dataUrl = nonEmptyString(args.dataUrl);
  const dataBase64 = nonEmptyString(args.dataBase64);
  let buffer = null;
  let mimeType = nonEmptyString(args.mimeType) || "image/png";

  if (dataUrl) {
    const parsed = parseDownloadDataUrl(dataUrl);
    buffer = parsed.buffer;
    mimeType = nonEmptyString(args.mimeType) || parsed.mimeType;
  } else if (dataBase64) {
    buffer = Buffer.from(dataBase64, "base64");
  } else {
    throw new Error("dataUrl or dataBase64 is required.");
  }

  if (!buffer.length) throw new Error("Cowart clipboard image data is empty.");
  if (buffer.length > MAX_COWART_IMAGE_BYTES) {
    throw new Error(`Cowart clipboard image exceeds the ${MAX_COWART_IMAGE_BYTES} byte safety limit.`);
  }
  if (mimeType !== "image/png") throw new Error(`Cowart clipboard only supports image/png, received ${mimeType}.`);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Cowart clipboard data is not a valid PNG image.");
  }

  const dimensions = readPngDimensions(buffer);
  if (args.dryRun !== true) {
    await writePngToSystemClipboard(buffer);
  }

  return {
    ok: true,
    mimeType,
    fileSize: buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    platform: platform(),
    dryRun: args.dryRun === true,
  };
}

function readPngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Cowart clipboard PNG is missing its IHDR header.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function writePngToSystemClipboard(buffer) {
  const systemPlatform = platform();
  const tempDir = await mkdtemp(join(tmpdir(), "cowart-clipboard-"));
  const pngPath = join(tempDir, "cowart-copy.png");

  try {
    await writeFile(pngPath, buffer);
    if (systemPlatform === "darwin") {
      const script = [
        "on run argv",
        "set imageFile to POSIX file (item 1 of argv)",
        "set the clipboard to (read imageFile as «class PNGf»)",
        "end run",
      ].join("\n");
      await execFileAsync("/usr/bin/osascript", ["-e", script, pngPath], { timeout: 10000 });
      return;
    }

    if (systemPlatform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$image = [System.Drawing.Image]::FromFile($env:COWART_CLIPBOARD_PNG_PATH)",
        "try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }",
      ].join("; ");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", script],
        {
          env: { ...process.env, COWART_CLIPBOARD_PNG_PATH: pngPath },
          timeout: 10000,
        },
      );
      return;
    }

    throw new Error(`Cowart system clipboard is not supported on ${systemPlatform}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cowart system clipboard")) throw error;
    throw new Error(`系统剪贴板写入失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function registerCowartWidget(mcpServer) {
  registerWidgetResource(mcpServer, {
    name: "cowart-canvas-widget",
    uri: COWART_WIDGET_URI,
    title: "Cowart Canvas",
    description:
      "A native Codex widget that renders Cowart's tldraw canvas directly and persists canvas data in the active project.",
    connectDomains: COWART_CONNECT_DOMAINS,
    resourceDomains: COWART_RESOURCE_DOMAINS,
    frameDomains: COWART_FRAME_DOMAINS,
    html: async () => inlineWidget({
      html: await cowartStaticHtml(),
      appVersion: pluginManifest.version,
      initialDisplayMode: DEFAULT_DISPLAY_MODE,
    }),
  });

  registerAppTool(
    mcpServer,
    TOOL_RENDER_WIDGET,
    {
      title: "Render Cowart Canvas Widget",
      description:
        "Open, reopen, or explicitly refresh the native Cowart canvas for the active Codex project. Pass projectDir for the user's workspace so canvas data is stored under <projectDir>/canvas. A successful call creates a widget surface, so do not use this tool as a routine prerequisite when a Cowart canvas is already open.",
      inputSchema: {
        ...projectArgsSchema,
        title: z.string().trim().optional(),
        displayMode: displayModeSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: COWART_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": COWART_WIDGET_URI,
        "openai/outputTemplate": COWART_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening Cowart canvas...",
        "openai/toolInvocation/invoked": "Cowart canvas ready",
      },
    },
    async (input = {}) => {
      const { projectDir, canvasDir } = resolveCowartPaths(input);
      const title = nonEmptyString(input.title) || "Cowart Canvas";
      const preferredDisplayMode = normalizeDisplayMode(input.displayMode);

      return {
        content: [
          {
            type: "text",
            text: "Rendered Cowart canvas widget.",
          },
        ],
        structuredContent: {
          version: 1,
          widget: "cowart-canvas-widget",
          title,
          rendering: "native-widget",
          staticDir: COWART_STATIC_BUILD_DIR,
          projectDir,
          canvasDir,
          preferredDisplayMode,
        },
        _meta: {
          "openai/outputTemplate": COWART_WIDGET_URI,
          widgetData: {
            title,
            rendering: "native-widget",
            staticDir: COWART_STATIC_BUILD_DIR,
            projectDir,
            canvasDir,
            preferredDisplayMode,
          },
        },
      };
    },
  );
}

function registerCowartStateTools(mcpServer) {
  mcpServer.registerTool(
    TOOL_GET_CANVAS_STATE,
    {
      title: "Get Cowart Canvas State",
      description:
        "Read the project-backed Cowart canvas snapshot, view state, and storage paths. The widget uses this instead of a localhost /api/canvas request.",
      inputSchema: {
        ...projectArgsSchema,
        hydrateAssets: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const state = await readCowartCanvasState(input, { hydrateAssets: input.hydrateAssets === true });
      return {
        content: [
          {
            type: "text",
            text: `Loaded Cowart canvas state from ${state.canvasDir} (${state.storage}).`,
          },
        ],
        structuredContent: state,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_READ_PAGE_ASSET,
    {
      title: "Read Cowart Page Asset",
      description:
        "Read one project-local Cowart /page-assets/... image or HTML asset for lazy widget rendering. Prefer this over hydrating all assets into the canvas snapshot.",
      inputSchema: {
        ...projectArgsSchema,
        assetUrl: z.string().trim(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const asset = await readCowartPageAsset(input, { assetUrl: input.assetUrl });
      return {
        content: [
          {
            type: "text",
            text: `Loaded Cowart page asset ${asset.assetUrl}.`,
          },
        ],
        structuredContent: asset,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_CANVAS_STATE,
    {
      title: "Save Cowart Canvas State",
      description:
        "Persist a Cowart/tldraw store snapshot to the project canvas directory, preserving per-page files and page-local assets.",
      inputSchema: {
        ...projectArgsSchema,
        snapshot: z.any(),
        protectImageRecords: z.boolean().optional(),
        acknowledgedImageShapeDeletes: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await saveCowartCanvasSnapshot(input, input.snapshot);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: result.message || "Invalid Cowart canvas snapshot.",
            },
          ],
          structuredContent: result,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart canvas state (${result.storage}).`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_SELECTION_STATE,
    {
      title: "Save Cowart Selection State",
      description:
        "Persist the current Cowart widget selection to canvas/cowart-selection.json so Codex can target selected shapes.",
      inputSchema: {
        ...projectArgsSchema,
        selection: z.any(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await writeCowartSelectionState(input, input.selection);
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart selection state to ${result.path}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_VIEW_STATE,
    {
      title: "Save Cowart View State",
      description:
        "Persist the current Cowart page and camera state to canvas/cowart-view-state.json.",
      inputSchema: {
        ...projectArgsSchema,
        viewState: z.any(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await writeCowartViewState(input, input.viewState);
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart view state to ${result.path}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );
}

function registerCowartImageTools(mcpServer) {
  registerAppTool(
    mcpServer,
    TOOL_COPY_IMAGE_TO_CLIPBOARD,
    {
      title: "Copy Cowart PNG to system clipboard",
      description:
        "Copy a PNG rendered by the Cowart widget to the local system clipboard when the widget iframe cannot use the browser Clipboard API.",
      inputSchema: {
        ...projectArgsSchema,
        dataUrl: z.string().optional(),
        dataBase64: z.string().optional(),
        mimeType: z.literal("image/png").optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
        "openai/widgetAccessible": true,
      },
    },
    async (input = {}) => {
      const result = await copyCowartImageToClipboard(input);
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Validated Cowart clipboard PNG (${result.width}x${result.height}).`
              : `Copied Cowart PNG to the system clipboard (${result.width}x${result.height}).`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_DOWNLOAD_FILE,
    {
      title: "Download Cowart File",
      description:
        "Save an image, HTML draft, or exported Slides package file requested by the Cowart widget into the user's system Downloads folder.",
      inputSchema: {
        ...projectArgsSchema,
        assetUrl: z.string().trim().optional(),
        fileName: z.string().trim().max(MAX_COWART_FILE_NAME_CHARS).optional(),
        dataUrl: z.string().optional(),
        dataBase64: z.string().optional(),
        mimeType: z.string().trim().optional(),
        directoryName: z.string().trim().optional(),
        subdirectory: z.string().trim().optional(),
        uniqueDirectory: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await downloadCowartFile(input);
      return {
        content: [
          {
            type: "text",
            text: `Downloaded Cowart file to ${result.filePath}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_REFERENCE_IMAGE,
    {
      title: "Save Cowart Reference Image",
      description:
        "Save a widget-selected reference image into the current Cowart page's assets folder so Codex can read it from the local project when ui/message image attachments are unavailable.",
      inputSchema: {
        ...projectArgsSchema,
        holderShapeId: z.string().trim().optional(),
        anchorShapeId: z.string().trim().optional(),
        pageId: z.string().trim().optional(),
        fileName: z.string().trim().max(MAX_COWART_FILE_NAME_CHARS).optional(),
        dataUrl: z.string().optional(),
        dataBase64: z.string().optional(),
        mimeType: z.string().trim().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await saveCowartReferenceImage(input);
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart reference image to ${result.assetPath}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_INSERT_HTML_DRAFT,
    {
      title: "Insert Cowart HTML Draft",
      description:
        "Save a single-file HTML draft into the current Cowart page's assets folder, update a targeted existing HTML draft in place, replace a targeted AI HTML holder, or append a 16:9 HTML page inside an AI Slides frame.",
      inputSchema: {
        ...projectArgsSchema,
        htmlContent: z.string().optional(),
        htmlPath: z.string().trim().optional(),
        draftShapeId: z.string().trim().optional(),
        anchorShapeId: z.string().trim().optional(),
        pageId: z.string().trim().optional(),
        fileName: z.string().trim().max(MAX_COWART_FILE_NAME_CHARS).optional(),
        placement: z.enum(["right", "left", "below"]).optional(),
        margin: z.number().optional(),
        matchAnchor: z.boolean().optional(),
        replaceDraftHolder: z.boolean().optional(),
        updateExistingDraft: z.boolean().optional(),
        displayWidth: z.number().optional(),
        displayHeight: z.number().optional(),
        shapeMeta: z.record(z.string(), z.unknown()).optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await insertCowartHtmlDraft(input);
      return {
        content: [
          {
            type: "text",
            text: `${result.dryRun ? "Planned" : "Inserted"} HTML draft ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}) using ${result.index}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_GET_SELECTION,
    {
      title: "Get Cowart Selection",
      description:
        "Return the currently selected Cowart/tldraw shapes and image asset metadata from a project's canvas/cowart-selection.json state file.",
      inputSchema: projectArgsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const { selection, selectionFile } = await readCowartSelectionState(input);
      const selectedShapes = selection.selectedShapes ?? [];
      const summary =
        selectedShapes.length === 0
          ? "No Cowart shapes are currently selected."
          : selectedShapes
              .map((shape) => {
                const assetName = shape.asset?.name ? ` (${shape.asset.name})` : "";
                return `${shape.id} [${shape.type ?? "unknown"}]${assetName}`;
              })
              .join("\n");

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { selection, selectionFile },
      };
    },
  );

  mcpServer.registerTool(
    TOOL_INSERT_IMAGE,
    {
      title: "Insert Cowart Image",
      description:
        "Accept exactly one explicit bitmap source (imagePath, dataUrl, or dataBase64), validate its signature and size, save it with a unique name in the project-local Cowart assets folder, create a tldraw image asset and shape, and replace a targeted AI image holder or place the image beside an anchor.",
      inputSchema: {
        imagePath: z.string().trim().max(4096).optional(),
        dataUrl: z.string().max(MAX_COWART_ENCODED_IMAGE_CHARS + 256).optional(),
        dataBase64: z.string().max(MAX_COWART_ENCODED_IMAGE_CHARS).optional(),
        mimeType: z.string().trim().max(128).optional(),
        projectDir: z.string().trim().min(1),
        canvasDir: z.string().trim().optional(),
        cowartUrl: z.string().trim().optional(),
        pageId: z.string().trim().optional(),
        anchorShapeId: z.string().trim().optional(),
        sourceShapeId: z.string().trim().optional(),
        fileName: z.string().trim().max(MAX_COWART_FILE_NAME_CHARS).optional(),
        placement: z.enum(["right", "left", "below"]).optional(),
        margin: z.number().optional(),
        matchAnchor: z.boolean().optional(),
        replaceAiImageHolder: z.boolean().optional(),
        displayWidth: z.number().optional(),
        displayHeight: z.number().optional(),
        altText: z.string().trim().optional(),
        annotationScreenshot: z.string().trim().optional(),
        shapeMeta: z.record(z.string(), z.unknown()).optional(),
        assetMeta: z.record(z.string(), z.unknown()).optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await insertCowartImage(input);
      return {
        content: [
          {
            type: "text",
            text: `${result.dryRun ? "Planned" : "Inserted"} ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}) using ${result.index}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );
}

function normalizeDisplayMode(displayMode) {
  const parsed = displayModeSchema.safeParse(displayMode);
  return parsed.success ? parsed.data : DEFAULT_DISPLAY_MODE;
}
