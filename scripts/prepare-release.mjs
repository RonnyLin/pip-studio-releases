import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [, , manifestArg, outputArg, tagArg, sourceDirectoryArg] = process.argv;

if (!manifestArg || !outputArg || !tagArg) {
  throw new Error(
    "Usage: node scripts/prepare-release.mjs <manifest> <output-dir> <tag> [source-directory]",
  );
}

const manifestPath = resolve(manifestArg);
const outputDirectory = resolve(outputArg);
const sourceDirectory = sourceDirectoryArg ? resolve(sourceDirectoryArg) : null;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assertPlainString(manifest.version, "version");
assertPlainString(manifest.title, "title");
assertPlainString(manifest.sourceBaseUrl, "sourceBaseUrl");
assertGitHubFileName(manifest.stableInstallerAlias, "stableInstallerAlias");

if (tagArg !== `v${manifest.version}`) {
  throw new Error(
    `Tag ${tagArg} does not match manifest version ${manifest.version}`,
  );
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("version must use X.Y.Z numeric SemVer form");
}

const sourceBaseUrl = new URL(manifest.sourceBaseUrl);
if (sourceBaseUrl.protocol !== "https:") {
  throw new Error("sourceBaseUrl must use HTTPS");
}
if (
  sourceBaseUrl.hostname !==
  "pip-studio-download-1421879931.cos.ap-guangzhou.myqcloud.com"
) {
  throw new Error(`Unexpected release source host: ${sourceBaseUrl.hostname}`);
}

const assets = [
  ["installer", manifest.installer],
  ["blockmap", manifest.blockmap],
  ["metadata", manifest.metadata],
];

for (const [label, asset] of assets) {
  validateAsset(label, asset);
}

await mkdir(outputDirectory, { recursive: true });

let sourceMetadataPath;
for (const [label, asset] of assets) {
  const sourcePath = join(outputDirectory, `.source-${label}-${process.pid}`);

  if (sourceDirectory) {
    await copyFile(join(sourceDirectory, asset.sourceFileName), sourcePath);
  } else {
    const assetUrl = new URL(
      encodeURIComponent(asset.sourceFileName),
      `${sourceBaseUrl.href.replace(/\/$/, "")}/`,
    );
    assetUrl.searchParams.set("expected-sha256", asset.sha256.toLowerCase());
    await downloadWithRetries(assetUrl, sourcePath, 4);
  }

  await verifyFile(sourcePath, `source ${label}`, asset);

  if (label === "metadata") {
    sourceMetadataPath = sourcePath;
  } else {
    const outputPath = join(outputDirectory, asset.releaseFileName);
    await rename(sourcePath, outputPath);
    await verifyFile(outputPath, `release ${label}`, asset);
  }
}

if (!sourceMetadataPath) {
  throw new Error("Release manifest did not produce source metadata");
}

const installerPath = join(outputDirectory, manifest.installer.releaseFileName);
await verifyPortableExecutable(installerPath);
await verifyElectronMetadata(
  sourceMetadataPath,
  manifest,
  manifest.installer.sourceFileName,
);

const releaseMetadataPath = join(
  outputDirectory,
  manifest.metadata.releaseFileName,
);
await createReleaseMetadata(sourceMetadataPath, releaseMetadataPath, manifest);
await rm(sourceMetadataPath, { force: true });
await verifyElectronMetadata(
  releaseMetadataPath,
  manifest,
  manifest.installer.releaseFileName,
);

const stableAliasPath = join(outputDirectory, manifest.stableInstallerAlias);
await copyFile(installerPath, stableAliasPath);
await verifyFile(stableAliasPath, "stable installer alias", manifest.installer);

const releaseAssets = [
  {
    fileName: manifest.installer.releaseFileName,
    size: manifest.installer.size,
    sha256: manifest.installer.sha256.toLowerCase(),
  },
  {
    fileName: manifest.blockmap.releaseFileName,
    size: manifest.blockmap.size,
    sha256: manifest.blockmap.sha256.toLowerCase(),
  },
  {
    fileName: manifest.metadata.releaseFileName,
    size: manifest.metadata.releaseSize,
    sha256: manifest.metadata.releaseSha256.toLowerCase(),
  },
  {
    fileName: manifest.stableInstallerAlias,
    size: manifest.installer.size,
    sha256: manifest.installer.sha256.toLowerCase(),
  },
];

const checksumText = `${releaseAssets
  .map((asset) => `${asset.sha256}  ${asset.fileName}`)
  .join("\n")}\n`;
const checksumPath = join(outputDirectory, "SHA256SUMS.txt");
await writeFile(checksumPath, checksumText, "utf8");
const checksumStats = await stat(checksumPath);

releaseAssets.push({
  fileName: "SHA256SUMS.txt",
  size: checksumStats.size,
  sha256: await sha256(checksumPath),
});

await writeFile(
  join(outputDirectory, "release-assets.json"),
  `${JSON.stringify({ title: manifest.title, assets: releaseAssets }, null, 2)}\n`,
  "utf8",
);
await writeFile(
  join(outputDirectory, "release-assets.txt"),
  `${releaseAssets.map((asset) => join(outputDirectory, asset.fileName)).join("\n")}\n`,
  "utf8",
);

console.log(
  `Prepared and verified ${releaseAssets.length} assets for ${tagArg}.`,
);

function assertPlainString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertPlainFileName(value, label) {
  assertPlainString(value, label);
  if (basename(value) !== value || value === "." || value === "..") {
    throw new Error(`${label} must be a plain file name`);
  }
}

function assertGitHubFileName(value, label) {
  assertPlainFileName(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `${label} must contain only GitHub-safe letters, digits, dots, underscores, and hyphens`,
    );
  }
}

function validateAsset(label, asset) {
  if (!asset || typeof asset !== "object") {
    throw new Error(`${label} must be an object`);
  }
  assertPlainFileName(asset.sourceFileName, `${label}.sourceFileName`);
  assertGitHubFileName(asset.releaseFileName, `${label}.releaseFileName`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`${label}.size must be a positive integer`);
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error(`${label}.sha256 must be a SHA-256 hex digest`);
  }
  if (label === "metadata") {
    if (!Number.isSafeInteger(asset.releaseSize) || asset.releaseSize <= 0) {
      throw new Error("metadata.releaseSize must be a positive integer");
    }
    if (!/^[a-f0-9]{64}$/i.test(asset.releaseSha256)) {
      throw new Error("metadata.releaseSha256 must be a SHA-256 hex digest");
    }
  }
}

async function downloadWithRetries(url, outputPath, attempts) {
  const partialPath = `${outputPath}.part`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(partialPath, { force: true });
    try {
      const response = await fetchHttps(url);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partialPath),
      );
      await rename(partialPath, outputPath);
      return;
    } catch (error) {
      lastError = error;
      await rm(partialPath, { force: true });
      if (attempt < attempts) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, attempt * 2000),
        );
      }
    }
  }

  throw new Error(`Failed to download ${url.href}: ${lastError}`);
}

async function fetchHttps(initialUrl) {
  let currentUrl = new URL(initialUrl);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (currentUrl.protocol !== "https:") {
      throw new Error(`Refusing non-HTTPS release URL: ${currentUrl.href}`);
    }

    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(
        `Redirect from ${currentUrl.href} did not include Location`,
      );
    }
    currentUrl = new URL(location, currentUrl);
  }

  throw new Error(`Too many redirects while downloading ${initialUrl.href}`);
}

async function verifyFile(filePath, label, asset) {
  const fileStats = await stat(filePath);
  if (fileStats.size !== asset.size) {
    throw new Error(
      `${label} size mismatch: expected ${asset.size}, received ${fileStats.size}`,
    );
  }

  const digest = await sha256(filePath);
  if (digest !== asset.sha256.toLowerCase()) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${asset.sha256}, received ${digest}`,
    );
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function sha512Base64(filePath) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("base64");
}

async function verifyPortableExecutable(filePath) {
  const handle = await open(filePath, "r");
  try {
    const signature = Buffer.alloc(2);
    await handle.read(signature, 0, 2, 0);
    if (signature.toString("ascii") !== "MZ") {
      throw new Error("Installer is not a Windows PE executable");
    }
  } finally {
    await handle.close();
  }
}

async function createReleaseMetadata(sourcePath, outputPath, releaseManifest) {
  const sourceMetadata = await readFile(sourcePath, "utf8");
  const sourceName = releaseManifest.installer.sourceFileName;
  const releaseName = releaseManifest.installer.releaseFileName;
  const occurrences = sourceMetadata.split(sourceName).length - 1;

  if (occurrences !== 2) {
    throw new Error(
      `Expected latest.yml to reference ${sourceName} twice, received ${occurrences}`,
    );
  }

  const releaseMetadata = sourceMetadata.split(sourceName).join(releaseName);
  await writeFile(outputPath, releaseMetadata, "utf8");
  await verifyFile(outputPath, "release metadata", {
    size: releaseManifest.metadata.releaseSize,
    sha256: releaseManifest.metadata.releaseSha256,
  });
}

async function verifyElectronMetadata(
  metadataPath,
  releaseManifest,
  expectedInstallerName,
) {
  const metadata = await readFile(metadataPath, "utf8");
  const version = capture(
    metadata,
    /^version:\s*['\"]?([^'\"\r\n]+)['\"]?\s*$/m,
    "version",
  );
  const fileUrl = capture(
    metadata,
    /^\s*-\s+url:\s*(.+?)\s*$/m,
    "files[0].url",
  );
  const fileSize = Number(
    capture(metadata, /^\s+size:\s*(\d+)\s*$/m, "files[0].size"),
  );
  const topLevelPath = capture(metadata, /^path:\s*(.+?)\s*$/m, "path");
  const topLevelSha512 = capture(metadata, /^sha512:\s*(\S+)\s*$/m, "sha512");

  const expected = releaseManifest.installer;
  const checks = [
    ["version", version, releaseManifest.version],
    ["files[0].url", fileUrl, expectedInstallerName],
    ["files[0].size", fileSize, expected.size],
    ["path", topLevelPath, expectedInstallerName],
    ["sha512", topLevelSha512, expected.sha512Base64],
  ];

  for (const [label, actual, wanted] of checks) {
    if (actual !== wanted) {
      throw new Error(
        `latest.yml ${label} mismatch: expected ${wanted}, received ${actual}`,
      );
    }
  }

  const actualSha512 = await sha512Base64(
    join(outputDirectory, releaseManifest.installer.releaseFileName),
  );
  if (actualSha512 !== expected.sha512Base64) {
    throw new Error(
      `Installer SHA-512 mismatch: expected ${expected.sha512Base64}, received ${actualSha512}`,
    );
  }
}

function capture(text, expression, label) {
  const match = text.match(expression);
  if (!match) {
    throw new Error(`latest.yml is missing ${label}`);
  }
  return match[1].trim();
}
