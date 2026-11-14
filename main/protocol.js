const path = require("path");
const fs = require("fs");
const os = require("os");
const { protocol } = require("electron");
const {
  PROJECT_ROOT,
  getStorageService,
  getPathResolver,
  getSandboxPolicyService,
  isKnownSessionOutputPath,
  asyncPathExists,
} = require("./shared");

const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: app: local-media:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: local-media:",
  "connect-src 'self' app: local-media: http: https: ws: wss:",
  "frame-src 'self' data: about: blob: local-media: http: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const LOCAL_MEDIA_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const LOCAL_MEDIA_RENDER_CSP =
  "sandbox; default-src 'none'; img-src local-media: data:; style-src 'unsafe-inline' local-media:; font-src local-media: data:; media-src local-media: data:; script-src 'none'; form-action 'none'; base-uri 'none'";

const INTERNAL_APP_URL_PREFIX = "app://dist/";

function registerPrivilegedSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        bypassCSP: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
    {
      scheme: "local-media",
      privileges: {
        standard: true,
        secure: true,
        bypassCSP: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

function isAllowedLocalMediaPath(targetPath) {
  const { resolveRealPathSafe, checkSensitivePath, isUnderFolderReal } = getSandboxPolicyService();
  const { DEFAULT_ROOT } = getPathResolver();
  const storageService = getStorageService();

  const resolved = resolveRealPathSafe(targetPath);

  if (checkSensitivePath(resolved).blocked) {
    return false;
  }

  const baseName = path.basename(resolved).toLowerCase();
  if (
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    resolved.includes(`${path.sep}.omcx${path.sep}config.json`)
  ) {
    return false;
  }

  if (storageService.isSessionAttachmentPath(resolved)) {
    return true;
  }

  if (isKnownSessionOutputPath(resolved)) {
    return true;
  }

  const wallpaperDir = path.join(os.homedir(), ".omcx", "wallpaper");
  const allowedRoots = new Set([DEFAULT_ROOT, wallpaperDir]);
  for (const ws of storageService.getWorkspaces()) {
    if (Array.isArray(ws.folders)) {
      for (const f of ws.folders) {
        if (f?.path) allowedRoots.add(path.resolve(f.path));
      }
    }
  }
  for (const sess of storageService.getSessions()) {
    if (sess?.work_dir) allowedRoots.add(path.resolve(sess.work_dir));
  }
  for (const root of allowedRoots) {
    if (isUnderFolderReal(resolved, root)) return true;
  }
  return false;
}

function registerProtocols() {
  const DIST_ROOT = path.resolve(PROJECT_ROOT, "dist");
  const { isUnderFolder } = getPathResolver();

  protocol.handle("local-media", async (request) => {
    try {
      let filePath = "";
      let wantsRender = false;
      try {
        const parsedUrl = new URL(request.url);
        wantsRender = parsedUrl.searchParams.get("render") === "1";
        if (parsedUrl.hostname === "local") {
          filePath = decodeURIComponent(parsedUrl.pathname);
        } else if (parsedUrl.hostname) {
          filePath = `/${parsedUrl.hostname}${decodeURIComponent(parsedUrl.pathname)}`;
        } else {
          filePath = decodeURIComponent(parsedUrl.pathname);
        }
      } catch {
        filePath = request.url;
        if (filePath.startsWith("local-media://")) {
          filePath = filePath.slice("local-media://".length);
        }
        const queryIndex = filePath.indexOf("?");
        if (queryIndex !== -1) filePath = filePath.substring(0, queryIndex);
        const hashIndex = filePath.indexOf("#");
        if (hashIndex !== -1) filePath = filePath.substring(0, hashIndex);
        filePath = decodeURIComponent(filePath);
        if (filePath.startsWith("local/")) {
          filePath = filePath.slice("local".length);
        }
      }

      if (process.platform === "win32") {
        if (filePath.startsWith("/")) filePath = filePath.slice(1);
        filePath = filePath.replace(/\//g, "\\");
      } else {
        if (!filePath.startsWith("/")) filePath = "/" + filePath;
      }

      let resolvedPath = path.resolve(filePath);
      if (process.platform === "darwin" && /^\/users\//i.test(resolvedPath)) {
        resolvedPath = "/Users/" + resolvedPath.slice("/users/".length);
      }

      if (!isAllowedLocalMediaPath(resolvedPath)) {
        console.warn(`[protocol:local-media] 拦截越界访问请求: ${resolvedPath}`);
        return new Response("Forbidden", { status: 403 });
      }

      if (!(await asyncPathExists(resolvedPath))) {
        console.warn(`[protocol:local-media] 文件不存在: ${resolvedPath}`);
        return new Response("File not found", { status: 404 });
      }

      const lower = resolvedPath.toLowerCase();
      let mimeType = "application/octet-stream";
      if (lower.endsWith(".png")) mimeType = "image/png";
      else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mimeType = "image/jpeg";
      else if (lower.endsWith(".webp")) mimeType = "image/webp";
      else if (lower.endsWith(".gif")) mimeType = "image/gif";
      else if (lower.endsWith(".svg")) mimeType = "image/svg+xml";
      else if (lower.endsWith(".html") || lower.endsWith(".htm")) mimeType = "text/plain; charset=utf-8";
      else if (lower.endsWith(".css")) mimeType = "text/plain; charset=utf-8";
      else if (lower.endsWith(".js") || lower.endsWith(".mjs")) mimeType = "text/plain; charset=utf-8";
      else if (lower.endsWith(".json")) mimeType = "text/plain; charset=utf-8";

      const isHtmlDoc = lower.endsWith(".html") || lower.endsWith(".htm");
      const renderAsDocument = isHtmlDoc && wantsRender;
      if (renderAsDocument) mimeType = "text/html; charset=utf-8";

      const fileBuffer = await fs.promises.readFile(resolvedPath);
      return new Response(fileBuffer, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
          "Content-Security-Policy": renderAsDocument ? LOCAL_MEDIA_RENDER_CSP : LOCAL_MEDIA_CSP,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error("Failed to load local file via local-media:", error);
      return new Response("File not found", { status: 404 });
    }
  });

  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      let relativePath = decodeURIComponent(url.pathname);
      if (relativePath.startsWith("/")) relativePath = relativePath.slice(1);

      let filePath = path.resolve(DIST_ROOT, relativePath);
      if (!isUnderFolder(filePath, DIST_ROOT)) {
        console.warn(`[protocol:app] 拦截路径穿越请求: ${request.url}`);
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(DIST_ROOT, "index.html");
        }
      } catch {
        filePath = path.join(DIST_ROOT, "index.html");
      }

      const buffer = await fs.promises.readFile(filePath);
      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Content-Security-Policy", RENDERER_CSP);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      if (filePath.endsWith(".html")) {
        headers.set("Content-Type", "text/html; charset=utf-8");
      } else if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
        headers.set("Content-Type", "text/javascript; charset=utf-8");
      } else if (filePath.endsWith(".css")) {
        headers.set("Content-Type", "text/css; charset=utf-8");
      } else if (filePath.endsWith(".svg")) {
        headers.set("Content-Type", "image/svg+xml");
      } else if (filePath.endsWith(".png")) {
        headers.set("Content-Type", "image/png");
      } else if (filePath.endsWith(".woff2")) {
        headers.set("Content-Type", "font/woff2");
      } else if (filePath.endsWith(".woff")) {
        headers.set("Content-Type", "font/woff");
      } else if (filePath.endsWith(".ttf")) {
        headers.set("Content-Type", "font/ttf");
      } else if (filePath.endsWith(".json")) {
        headers.set("Content-Type", "application/json; charset=utf-8");
      }

      return new Response(buffer, { status: 200, headers });
    } catch (err) {
      console.error("[protocol:app error]", err);
      try {
        const fallback = await fs.promises.readFile(path.join(DIST_ROOT, "index.html"));
        return new Response(fallback, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": RENDERER_CSP,
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response("Failed to load app", { status: 500 });
      }
    }
  });
}

module.exports = {
  INTERNAL_APP_URL_PREFIX,
  registerPrivilegedSchemes,
  registerProtocols,
};
