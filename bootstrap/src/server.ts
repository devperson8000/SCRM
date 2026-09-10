import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import http from "http";
import { extract } from "tar";
import { Readable } from "stream";
import fs from "fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  defaultConfig,
  EPOXY_TRANSPORT_PACKAGE_NAME,
  EPOXY_TRANSPORT_PINNED_MAJOR_VERSION,
  LIBCURL_TRANSPORT_PACKAGE_NAME,
  LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION,
  REGISTRY_URL,
  SCRAMJET_CONTROLLER_PACKAGE_NAME,
  SCRAMJET_CONTROLLER_PINNED_MAJOR_VERSION,
  SCRAMJET_PACKAGE_NAME,
  SCRAMJET_UTILS_PACKAGE_NAME,
  SCRAMJET_UTILS_PINNED_MAJOR_VERSION,
  BootstrapOptions,
} from "./common";

const bootstrapRoot = import.meta.dirname;

type ServerBootstrapOptions = BootstrapOptions & {
  downloadedFilesDir: string;
};

let config: ServerBootstrapOptions;

type CachedAsset = { body: Buffer; etag: string; mtimeMs: number };

// These assets are downloaded once at bootstrap and then never change until the
// next bootstrap, but every request used to hit the disk for the full file —
// including the multi-megabyte scramjet.wasm, on every single page load.
const assetCache = new Map<string, CachedAsset>();

async function loadAsset(filePath: string): Promise<CachedAsset> {
  const stat = await fs.stat(filePath);
  const cached = assetCache.get(filePath);
  // mtime-keyed so a re-bootstrap that replaces a file is picked up without
  // needing a restart.
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const body = await fs.readFile(filePath);
  const asset: CachedAsset = {
    body,
    etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
    mtimeMs: stat.mtimeMs,
  };
  assetCache.set(filePath, asset);

  return asset;
}

async function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  contentType: string,
) {
  let asset: CachedAsset;
  try {
    asset = await loadAsset(filePath);
  } catch (err) {
    // Previously this rejected into nothing: the client got no response at
    // all and hung until it timed out, with no hint as to why.
    console.error(`Failed to serve ${filePath}:`, err);
    if (!res.headersSent) {
      const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
      res.writeHead(missing ? 404 : 500, { "Content-Type": "text/plain" });
      res.end(missing ? "Not found\n" : "Internal server error\n");
    }

    return;
  }

  // Revalidation instead of a full re-download of the bundle and wasm on
  // every reload.
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, { ETag: asset.etag, "Cache-Control": "no-cache" });
    res.end();

    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": asset.body.byteLength,
    ETag: asset.etag,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else res.end(asset.body);
}
const clientdata = await fs.readFile(
  join(bootstrapRoot, "bootstrap-client.js"),
);
// Recomputed once instead of per request: this base64 of the whole client
// bundle was being rebuilt on every hit of the init path.
const clientDataBase64 = Buffer.from(clientdata).toString("base64");

function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!req.url) return false;
  // A query string ("?v=2", a cache buster) made every one of these exact
  // comparisons miss and fall through as if the route didn't exist.
  const pathname = req.url.split("?")[0];

  if (pathname === config.swPath) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(`importScripts("${config.scramjetControllerSwPath}");
addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) {
		e.respondWith($scramjetController.route(e));
	}
});
`);

    return true;
  } else if (pathname === config.bootstrapInitPath) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(`async function initBootstrap() {
	const { init } = await import("data:text/javascript;base64,${clientDataBase64}");
	return init(${JSON.stringify(config)});
}`);

    return true;
  }

  const pathsToFiles = {
    [config.scramjetControllerApiPath]:
      config.downloadedFilesDir + "controller/package/dist/controller.api.js",
    [config.scramjetControllerInjectPath]:
      config.downloadedFilesDir +
      "controller/package/dist/controller.inject.js",
    [config.scramjetControllerSwPath]:
      config.downloadedFilesDir + "controller/package/dist/controller.sw.js",
    [config.scramjetBundlePath]:
      config.downloadedFilesDir + "scramjet/package/dist/scramjet.js",
    [config.scramjetWasmPath]:
      config.downloadedFilesDir + "scramjet/package/dist/scramjet.wasm",
    [config.scramjetUtilsBundlePath]:
      config.downloadedFilesDir +
      "scramjet-utils/package/dist/scramjet-utils.js",

    [config.libcurlClientPath]:
      config.downloadedFilesDir + "libcurl-transport/package/dist/index.js",
  };
  if (Object.prototype.hasOwnProperty.call(pathsToFiles, pathname)) {
    const filePath = pathsToFiles[pathname as keyof typeof pathsToFiles];
    const contentType = pathname.endsWith(".wasm")
      ? "application/wasm"
      : "application/javascript";
    void sendFile(req, res, filePath, contentType);
    return true;
  }

  return false;
}

function routeUpgrade(
  req: http.IncomingMessage,
  socket: any,
  head: Buffer,
): boolean {
  if (!req.url) return false;
  if (!req.url.startsWith("/wisp/")) return false;

  wisp.routeRequest(req, socket, head);
  return true;
}

export async function unpack(tarball: string, name: string) {
  if (!name) throw new Error("no package name!");
  // A registry that accepts the connection and then stalls used to hang
  // bootstrap forever; fetch has no default timeout.
  const response = await fetch(tarball, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  await fs.mkdir(config.downloadedFilesDir, { recursive: true });
  const file = `${config.downloadedFilesDir}${name}.tgz`;
  await fs.writeFile(file, buffer);

  const packagedir = `${config.downloadedFilesDir}/${name}`;

  if (await fs.stat(packagedir).catch(() => false)) {
    await fs.rm(packagedir, { recursive: true, force: true });
  }
  await fs.mkdir(packagedir, { recursive: true });

  try {
    await extract({
      f: file,
      cwd: packagedir,
    });
    await fs.unlink(file);
  } catch (err) {
    console.error("Error extracting tarball:", err);
    await fs.unlink(file);
    throw err;
  }
}

async function getDownloadedPackageVersion(
  name: string,
): Promise<string | null> {
  const packagedir = `${config.downloadedFilesDir}${name}`;
  try {
    const pkgJson = JSON.parse(
      (await fs.readFile(
        `${packagedir}/package/package.json`,
        "utf-8",
      )) as unknown as string,
    );
    return pkgJson.version;
  } catch {
    return null;
  }
}

// An unchecked response body meant a 404 or a registry outage surfaced as
// "Cannot read properties of undefined (reading 'versions')" several frames
// away from the actual cause.
async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Registry request failed (${response.status}): ${url}`);
  }

  return response.json();
}

async function updateScramjet(controllerMeta: any) {
  const scramjetVersion =
    controllerMeta.devDependencies["@mercuryworkshop/scramjet"];

  console.log(`Fetching scramjet version: ${scramjetVersion}`);
  const scramjetMeta = await fetchJson(
    `${REGISTRY_URL}${SCRAMJET_PACKAGE_NAME}/${scramjetVersion}`,
  );

  await unpack(scramjetMeta.dist.tarball, "scramjet");
  await unpack(controllerMeta.dist.tarball, "controller");
}

export async function findLatestVersionOfPackage(
  packageName: string,
  majorVersion: string,
): Promise<NodePackageMeta> {
  const packageMeta = await fetchJson(`${REGISTRY_URL}${packageName}`);
  const versions = Object.keys(packageMeta.versions ?? {}).filter((v) =>
    v.startsWith(`${majorVersion}.`),
  );
  const sortedVersions = versions.sort((a, b) => {
    const aParts = a.split(".").map(Number);
    const bParts = b.split(".").map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) return bVal - aVal;
    }
    return 0;
  });
  if (sortedVersions.length === 0) {
    throw new Error(
      `No versions found for package ${packageName} with major version ${majorVersion}`,
    );
  }
  const latestVersion = sortedVersions[0];

  return fetchJson(`${REGISTRY_URL}${packageName}/${latestVersion}`);
}

type NodePackageMeta = {
  name: string;
  version: string;
  dist: {
    tarball: string;
  };
  dependencies: { [key: string]: string };
};

export async function bootstrap(
  cfg: Partial<ServerBootstrapOptions> = {},
): Promise<{
  routeRequest: typeof routeRequest;
  routeUpgrade: typeof routeUpgrade;
}> {
  config = {
    ...defaultConfig,
    ...cfg,
    downloadedFilesDir: join(bootstrapRoot, ".downloads") + "/",
  } as ServerBootstrapOptions;

  const downloadedControllerVersion =
    await getDownloadedPackageVersion("controller");
  if (downloadedControllerVersion) {
    console.log(
      `Found downloaded Scramjet Controller version: ${downloadedControllerVersion}`,
    );
  }

  if (config.transport === "epoxy") {
    const epoxyMeta = await findLatestVersionOfPackage(
      EPOXY_TRANSPORT_PACKAGE_NAME,
      EPOXY_TRANSPORT_PINNED_MAJOR_VERSION,
    );
    await unpack(epoxyMeta.dist.tarball, "epoxy-transport");
    console.log(`Using Epoxy Transport version: ${epoxyMeta.version}`);
  } else if (config.transport === "libcurl") {
    const libcurlMeta = await findLatestVersionOfPackage(
      LIBCURL_TRANSPORT_PACKAGE_NAME,
      LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION,
    );
    await unpack(libcurlMeta.dist.tarball, "libcurl-transport");
    console.log(`Using libcurl Transport version: ${libcurlMeta.version}`);
  } else {
    throw new Error(`Unknown transport option: ${config.transport}`);
  }

  const controllerMeta = await findLatestVersionOfPackage(
    SCRAMJET_CONTROLLER_PACKAGE_NAME,
    SCRAMJET_CONTROLLER_PINNED_MAJOR_VERSION,
  );

  if (downloadedControllerVersion === controllerMeta.version) {
    console.log(
      `Scramjet Controller is up to date (version: ${downloadedControllerVersion}), skipping download.`,
    );
  } else {
    await updateScramjet(controllerMeta);
    console.log(
      `Downloaded Scramjet Controller version: ${controllerMeta.version}`,
    );
  }

  const downloadedUtilsVersion =
    await getDownloadedPackageVersion("scramjet-utils");
  const utilsMeta = await findLatestVersionOfPackage(
    SCRAMJET_UTILS_PACKAGE_NAME,
    SCRAMJET_UTILS_PINNED_MAJOR_VERSION,
  );
  if (downloadedUtilsVersion === utilsMeta.version) {
    console.log(
      `Scramjet Utils is up to date (version: ${downloadedUtilsVersion}), skipping download.`,
    );
  } else {
    await unpack(utilsMeta.dist.tarball, "scramjet-utils");
    console.log(`Downloaded Scramjet Utils version: ${utilsMeta.version}`);
  }

  return {
    routeRequest,
    routeUpgrade,
  };
}
