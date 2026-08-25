import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transportEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const serverRoot = path.resolve(optionValue("--server-root") || process.cwd());
const maximumStartupMs = Number(optionValue("--max-startup-ms") || 0);
transportEnvironment.COWART_PLUGIN_ROOT = serverRoot;
const transport = new StdioClientTransport({
  command: "node",
  args: ["./scripts/start-mcp.mjs"],
  cwd: serverRoot,
  env: transportEnvironment,
});

const client = new Client({
  name: "cowart-probe",
  version: "0.1.0",
});
const toolsOnly = process.argv.includes("--tools-only");
const expectedDirectImageMaxLength = Math.ceil(16 * 1024 * 1024 * 4 / 3) + 4;

const startupStartedAt = performance.now();
await client.connect(transport);

let downloadedProbePath = null;
let downloadedProbeDirectory = null;
let projectDir = null;
let junctionTargetDir = null;
let rootAliasCanvasDir = null;
let vitePathProbeSequence = 0;

function isCanvasDirectory(value) {
  const canvasDir = String(value || "");
  return (
    path.basename(path.normalize(canvasDir)) === "canvas" ||
    path.win32.basename(path.win32.normalize(canvasDir)) === "canvas"
  );
}

try {
  probe: {
  const tools = await client.listTools();
  const startupMs = performance.now() - startupStartedAt;
  if (maximumStartupMs > 0 && startupMs > maximumStartupMs) {
    throw new Error(
      `Cowart MCP tool discovery took ${Math.round(startupMs)} ms; expected at most ${maximumStartupMs} ms.`,
    );
  }
  const toolNames = tools.tools.map((tool) => tool.name);
  const requiredTools = [
    "render_cowart_canvas_widget",
    "get_cowart_canvas_state",
    "save_cowart_canvas_state",
    "save_cowart_selection_state",
    "save_cowart_view_state",
    "save_cowart_reference_image",
    "read_cowart_page_asset",
    "download_cowart_file",
    "copy_cowart_image_to_clipboard",
    "get_cowart_selection",
    "insert_cowart_image",
    "insert_cowart_html_draft",
  ];

  for (const toolName of requiredTools) {
    if (!toolNames.includes(toolName)) {
      throw new Error(`${toolName} not found. Tools: ${toolNames.join(", ")}`);
    }
  }

  if (toolNames.includes("track_cowart_analytics_event")) {
    throw new Error("Cowart Safe must not expose the analytics tool.");
  }
  const clipboardTool = tools.tools.find((tool) => tool.name === "copy_cowart_image_to_clipboard");
  if (JSON.stringify(clipboardTool?._meta?.ui?.visibility) !== JSON.stringify(["app"])) {
    throw new Error("Cowart clipboard tool should only be visible to the widget app.");
  }
  const insertImageTool = tools.tools.find((tool) => tool.name === "insert_cowart_image");
  if (insertImageTool?.inputSchema?.properties?.dataBase64?.maxLength !== expectedDirectImageMaxLength) {
    throw new Error("Cowart Safe direct image payload should use the bounded 16 MiB binary limit.");
  }
  if (insertImageTool?.inputSchema?.properties?.fileName?.maxLength !== 180) {
    throw new Error("Cowart Safe image filenames should use the cross-platform component length limit.");
  }

  const missingProjectResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {},
  });
  if (missingProjectResult.isError !== true) {
    throw new Error("Cowart Safe must reject tool calls that omit projectDir.");
  }

  const pluginProjectResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: { projectDir: serverRoot },
  });
  if (pluginProjectResult.isError !== true) {
    throw new Error("Cowart Safe must reject the plugin source directory as project storage.");
  }

  projectDir = await mkdtemp(path.join(tmpdir(), "cowart-widget-probe-"));
  const escapedCanvasResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {
      projectDir,
      canvasDir: path.resolve(projectDir, "..", "cowart-escaped-canvas"),
    },
  });
  if (escapedCanvasResult.isError !== true) {
    throw new Error("Cowart Safe must reject canvasDir values outside projectDir.");
  }
  junctionTargetDir = await mkdtemp(path.join(tmpdir(), "cowart-junction-target-"));
  const junctionCanvasDir = path.join(projectDir, "canvas-junction");
  await symlink(junctionTargetDir, junctionCanvasDir, process.platform === "win32" ? "junction" : "dir");
  const junctionCanvasResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {
      projectDir,
      canvasDir: junctionCanvasDir,
    },
  });
  if (junctionCanvasResult.isError !== true) {
    throw new Error("Cowart Safe must reject canvasDir junctions or symlinks that escape projectDir.");
  }
  await assertViteDevelopmentRejectsEscapedCanvas(projectDir, junctionCanvasDir);
  rootAliasCanvasDir = path.join(projectDir, "canvas-root-alias");
  await symlink(projectDir, rootAliasCanvasDir, process.platform === "win32" ? "junction" : "dir");
  const rootAliasCanvasResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {
      projectDir,
      canvasDir: rootAliasCanvasDir,
    },
  });
  if (rootAliasCanvasResult.isError !== true) {
    throw new Error("Cowart Safe must reject canvasDir aliases that resolve to projectDir itself.");
  }
  await assertViteDevelopmentRejectsEscapedCanvas(projectDir, rootAliasCanvasDir);
  await unlink(rootAliasCanvasDir);
  rootAliasCanvasDir = null;
  const renderResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {
      projectDir,
      title: "Probe Cowart",
    },
  });
  if (renderResult._meta?.["openai/outputTemplate"] !== "ui://widget/cowart/canvas.html") {
    throw new Error("Cowart render tool result did not include the expected outputTemplate.");
  }
  if (renderResult.structuredContent?.preferredDisplayMode !== "fullscreen") {
    throw new Error("Cowart render tool did not default to fullscreen display mode.");
  }
  if (renderResult.structuredContent?.projectDir !== projectDir) {
    throw new Error("Cowart render tool did not preserve the requested projectDir.");
  }
  if (toolsOnly) {
    console.log(
      `OK: Cowart MCP tools are available before the widget resource is built (${Math.round(startupMs)} ms).`,
    );
    break probe;
  }

  const stateResult = await client.callTool({
    name: "get_cowart_canvas_state",
    arguments: {
      projectDir,
    },
  });
  if (stateResult.structuredContent?.storage !== "empty") {
    throw new Error("A fresh Cowart project should report empty storage.");
  }
  if (!isCanvasDirectory(stateResult.structuredContent?.canvasDir)) {
    throw new Error("Cowart canvas state did not report a project-local canvas directory.");
  }
  if ((stateResult.structuredContent?.hydratedAssets || []).length !== 0) {
    throw new Error("Cowart canvas state should not hydrate image assets by default.");
  }

  const saveResult = await client.callTool({
    name: "save_cowart_canvas_state",
    arguments: {
      projectDir,
      snapshot: minimalProbeCanvasSnapshot(),
    },
  });
  if (saveResult.isError === true || saveResult.structuredContent?.ok !== true) {
    throw new Error("Cowart probe could not create a valid project canvas snapshot.");
  }

  const probePageAssetDir = path.join(projectDir, "canvas", "pages", "probe-page", "assets");
  await mkdir(probePageAssetDir, { recursive: true });
  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const tinyPngPath = path.join(probePageAssetDir, "tiny.png");
  await writeFile(
    tinyPngPath,
    Buffer.from(tinyPngBase64, "base64"),
  );
  await writeFile(path.join(probePageAssetDir, "draft.html"), "<!doctype html><html><body>draft</body></html>");
  const pageAssetResult = await client.callTool({
    name: "read_cowart_page_asset",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/tiny.png",
    },
  });
  if (pageAssetResult.structuredContent?.mimeType !== "image/png" || !pageAssetResult.structuredContent?.dataBase64) {
    throw new Error("Cowart page asset tool did not return the expected png payload.");
  }
  const htmlAssetResult = await client.callTool({
    name: "read_cowart_page_asset",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/draft.html",
    },
  });
  if (htmlAssetResult.structuredContent?.mimeType !== "text/html" || !htmlAssetResult.structuredContent?.dataBase64) {
    throw new Error("Cowart page asset tool did not return the expected html payload.");
  }

  const missingImageSourceResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: { projectDir, pageId: "page:probe" },
  });
  if (missingImageSourceResult.isError !== true) {
    throw new Error("Cowart Safe must require exactly one explicit image source.");
  }

  const multipleImageSourcesResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataBase64: tinyPngBase64,
      dataUrl: `data:image/png;base64,${tinyPngBase64}`,
    },
  });
  if (multipleImageSourcesResult.isError !== true) {
    throw new Error("Cowart Safe must reject ambiguous calls with multiple image sources.");
  }

  const mismatchedMimeResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataBase64: tinyPngBase64,
      mimeType: "image/jpeg",
    },
  });
  if (mismatchedMimeResult.isError !== true) {
    throw new Error("Cowart Safe must reject MIME declarations that do not match the bitmap signature.");
  }

  const nonBase64DataUrlResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataUrl: "data:image/png,not-base64",
    },
  });
  if (nonBase64DataUrlResult.isError !== true) {
    throw new Error("Cowart Safe must reject non-base64 image data URLs.");
  }

  const oversizedFileNameResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataBase64: tinyPngBase64,
      fileName: `${"a".repeat(181)}.png`,
    },
  });
  if (oversizedFileNameResult.isError !== true) {
    throw new Error("Cowart Safe must reject oversized image filenames before filesystem access.");
  }

  const directBase64Result = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataBase64: tinyPngBase64,
      mimeType: "image/png",
      fileName: "direct-payload.not-png",
    },
  });
  const directBase64Payload = directBase64Result.structuredContent || {};
  if (
    directBase64Result.isError === true ||
    directBase64Payload.sourceType !== "dataBase64" ||
    directBase64Payload.sourceImagePath !== null ||
    path.extname(directBase64Payload.assetFile || "") !== ".png" ||
    !(await readFile(directBase64Payload.assetFile)).equals(Buffer.from(tinyPngBase64, "base64")) ||
    JSON.stringify(directBase64Result).includes(tinyPngBase64)
  ) {
    throw new Error("Cowart Safe did not securely insert the direct base64 PNG payload.");
  }

  const directDataUrlResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataUrl: `data:image/png;base64,${tinyPngBase64}`,
      fileName: "direct-payload.png",
    },
  });
  const directDataUrlPayload = directDataUrlResult.structuredContent || {};
  if (
    directDataUrlResult.isError === true ||
    directDataUrlPayload.sourceType !== "dataUrl" ||
    path.basename(directDataUrlPayload.assetFile || "") !== "direct-payload-v2.png" ||
    JSON.stringify(directDataUrlResult).includes(tinyPngBase64)
  ) {
    throw new Error("Cowart Safe did not securely insert the direct data URL with a unique filename.");
  }

  const unpaddedBase64Url = tinyPngBase64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  const unpaddedBase64Result = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      dataBase64: unpaddedBase64Url,
      mimeType: "image/png",
      fileName: "direct-payload.png",
    },
  });
  if (
    unpaddedBase64Result.isError === true ||
    path.basename(unpaddedBase64Result.structuredContent?.assetFile || "") !== "direct-payload-v3.png" ||
    !(await readFile(unpaddedBase64Result.structuredContent?.assetFile)).equals(Buffer.from(tinyPngBase64, "base64"))
  ) {
    throw new Error("Cowart Safe did not accept a canonical unpadded base64url image payload.");
  }

  const localPathResult = await client.callTool({
    name: "insert_cowart_image",
    arguments: {
      projectDir,
      pageId: "page:probe",
      imagePath: tinyPngPath,
    },
  });
  if (
    localPathResult.isError === true ||
    localPathResult.structuredContent?.sourceType !== "imagePath" ||
    localPathResult.structuredContent?.sourceImagePath !== tinyPngPath ||
    !(await readFile(localPathResult.structuredContent?.assetFile)).equals(Buffer.from(tinyPngBase64, "base64"))
  ) {
    throw new Error("Cowart Safe did not preserve the explicit local-path insertion flow.");
  }

  const clipboardResult = await client.callTool({
    name: "copy_cowart_image_to_clipboard",
    arguments: {
      projectDir,
      dataBase64: pageAssetResult.structuredContent.dataBase64,
      mimeType: "image/png",
      dryRun: true,
    },
  });
  if (
    clipboardResult.structuredContent?.dryRun !== true ||
    clipboardResult.structuredContent?.width !== 1 ||
    clipboardResult.structuredContent?.height !== 1
  ) {
    throw new Error("Cowart clipboard tool did not validate the expected PNG payload.");
  }

  const downloadResult = await client.callTool({
    name: "download_cowart_file",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/tiny.png",
      fileName: `cowart-download-probe-${process.pid}.png`,
    },
  });
  downloadedProbePath = downloadResult.structuredContent?.filePath;
  if (!downloadedProbePath || !(await readFile(downloadedProbePath)).length) {
    throw new Error("Cowart download tool did not write the expected file into Downloads.");
  }

  const folderDownloadResult = await client.callTool({
    name: "download_cowart_file",
    arguments: {
      projectDir,
      dataUrl: "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3Eprobe%3C%2Ftitle%3E",
      directoryName: `Cowart Slides Probe ${process.pid}`,
      subdirectory: "pages",
      fileName: "page-01.html",
      mimeType: "text/html",
      uniqueDirectory: true,
    },
  });
  downloadedProbeDirectory = folderDownloadResult.structuredContent?.directoryPath;
  const folderDownloadPath = folderDownloadResult.structuredContent?.filePath;
  if (
    !downloadedProbeDirectory ||
    path.basename(path.dirname(folderDownloadPath || "")) !== "pages" ||
    !(await readFile(folderDownloadPath, "utf8")).includes("<title>probe</title>")
  ) {
    throw new Error("Cowart download tool did not create the expected Slides export folder structure.");
  }

  const resource = await client.readResource({
    uri: "ui://widget/cowart/canvas.html",
  });
  const resourceMeta = resource.contents?.[0]?._meta || {};
  const widgetCsp = resourceMeta["openai/widgetCSP"] || {};
  const connectDomains = widgetCsp.connect_domains || [];
  if (connectDomains.length !== 0) {
    throw new Error(`Cowart Safe widget CSP must not allow network connections. Found: ${connectDomains.join(", ")}`);
  }
  const resourceDomains = widgetCsp.resource_domains || [];
  if (!resourceDomains.includes("data:") || !resourceDomains.includes("blob:")) {
    throw new Error(`Cowart widget CSP should allow local data/blob resources. Found: ${resourceDomains.join(", ")}`);
  }
  if (resourceDomains.some((domain) => /^https?:/i.test(domain))) {
    throw new Error(`Cowart Safe widget CSP must not allow remote resources. Found: ${resourceDomains.join(", ")}`);
  }
  const frameDomains = widgetCsp.frame_domains || [];
  if (!frameDomains.includes("data:") || !frameDomains.includes("blob:")) {
    throw new Error(`Cowart widget CSP should allow local data/blob iframes for HTML drafts. Found: ${frameDomains.join(", ")}`);
  }
  if (frameDomains.some((domain) => /^https?:/i.test(domain))) {
    throw new Error(`Cowart Safe widget CSP must not allow remote frames. Found: ${frameDomains.join(", ")}`);
  }

  const widgetHtml = resource.contents?.[0]?.text || "";
  if (!widgetHtml.includes("window.cowartMcp") || !widgetHtml.includes("Cowart Canvas")) {
    throw new Error("Cowart widget HTML does not include the expected bridge and app shell.");
  }
  if (/<script\b[^>]*\btype="module"/i.test(widgetHtml)) {
    throw new Error("Cowart widget HTML should use classic inline scripts for host compatibility.");
  }
  const shellMarkup = widgetHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  if (/<iframe\b/i.test(shellMarkup) || /<script\b[^>]+\bsrc=/i.test(shellMarkup) || /<link\b[^>]+\bhref=/i.test(shellMarkup)) {
    throw new Error("Cowart widget HTML should be direct static markup without iframe or external asset tags.");
  }

  console.log(
    `OK: Cowart MCP tools and native widget resource are available (${Math.round(startupMs)} ms startup).`,
  );
  }
} finally {
  if (downloadedProbePath) {
    await unlink(downloadedProbePath).catch(() => undefined);
  }
  if (downloadedProbeDirectory) {
    await rm(downloadedProbeDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (rootAliasCanvasDir) {
    await unlink(rootAliasCanvasDir).catch(() => undefined);
  }
  if (projectDir) {
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (junctionTargetDir) {
    await rm(junctionTargetDir, { recursive: true, force: true }).catch(() => undefined);
  }
  await client.close();
}

function optionValue(name) {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex !== -1) return process.argv[exactIndex + 1] || "";
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : "";
}

async function assertViteDevelopmentRejectsEscapedCanvas(projectDir, canvasDir) {
  const previous = {
    projectDir: process.env.COWART_PROJECT_DIR,
    canvasDir: process.env.COWART_CANVAS_DIR,
    widgetBuild: process.env.COWART_WIDGET_BUILD,
  };
  process.env.COWART_PROJECT_DIR = projectDir;
  process.env.COWART_CANVAS_DIR = canvasDir;
  delete process.env.COWART_WIDGET_BUILD;
  let rejected = false;
  try {
    vitePathProbeSequence += 1;
    const configUrl = new URL(`../vite.config.js?cowart-path-probe=${vitePathProbeSequence}`, import.meta.url);
    await import(configUrl.href);
  } catch (error) {
    rejected = /symlink or junction outside projectDir/u.test(String(error?.message || error));
    if (!rejected) throw error;
  } finally {
    restoreEnvironment("COWART_PROJECT_DIR", previous.projectDir);
    restoreEnvironment("COWART_CANVAS_DIR", previous.canvasDir);
    restoreEnvironment("COWART_WIDGET_BUILD", previous.widgetBuild);
  }
  if (!rejected) {
    throw new Error("Cowart Safe Vite development mode must reject escaped canvas junctions or symlinks.");
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function minimalProbeCanvasSnapshot() {
  return {
    store: {
      "page:probe": {
        id: "page:probe",
        typeName: "page",
        name: "Probe",
        index: "a1",
        meta: {},
      },
    },
    schema: {
      schemaVersion: 2,
      sequences: {
        "com.tldraw.store": 5,
        "com.tldraw.asset": 1,
        "com.tldraw.camera": 1,
        "com.tldraw.document": 2,
        "com.tldraw.instance": 26,
        "com.tldraw.instance_page_state": 5,
        "com.tldraw.page": 1,
        "com.tldraw.instance_presence": 6,
        "com.tldraw.pointer": 1,
        "com.tldraw.shape": 4,
        "com.tldraw.user": 1,
        "com.tldraw.asset.image": 6,
        "com.tldraw.asset.video": 5,
        "com.tldraw.asset.bookmark": 2,
        "com.tldraw.shape.arrow": 8,
        "com.tldraw.shape.bookmark": 2,
        "com.tldraw.shape.draw": 4,
        "com.tldraw.shape.embed": 4,
        "com.tldraw.shape.frame": 1,
        "com.tldraw.shape.geo": 11,
        "com.tldraw.shape.group": 0,
        "com.tldraw.shape.highlight": 3,
        "com.tldraw.shape.image": 5,
        "com.tldraw.shape.line": 5,
        "com.tldraw.shape.note": 12,
        "com.tldraw.shape.text": 4,
        "com.tldraw.shape.video": 4,
        "com.tldraw.binding.arrow": 1,
      },
    },
  };
}
