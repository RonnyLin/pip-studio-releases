import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [, , expectedArg, actualArg, assetDirectory, tagArg] = process.argv;
if (!expectedArg || !actualArg || !assetDirectory || !tagArg) {
  throw new Error(
    "Usage: node scripts/plan-release-upload.mjs <expected-json> <actual-json> <asset-dir> <tag>",
  );
}

const expected = JSON.parse(await readFile(expectedArg, "utf8"));
const actual = JSON.parse(await readFile(actualArg, "utf8"));

if (actual.tag_name !== tagArg) {
  throw new Error(
    `Release tag mismatch: expected ${tagArg}, received ${actual.tag_name}`,
  );
}

const expectedByName = new Map(
  expected.assets.map((asset) => [asset.fileName, asset]),
);
const actualByName = new Map(actual.assets.map((asset) => [asset.name, asset]));

for (const asset of actual.assets) {
  const wanted = expectedByName.get(asset.name);
  if (!wanted) {
    throw new Error(`Release contains unexpected asset ${asset.name}`);
  }
  verifyExistingAsset(asset, wanted);
}

const missing = expected.assets.filter(
  (asset) => !actualByName.has(asset.fileName),
);

if (!actual.draft && missing.length > 0) {
  throw new Error("Published release is incomplete and will not be modified");
}

for (const asset of missing) {
  console.log(join(assetDirectory, asset.fileName));
}

function verifyExistingAsset(asset, wanted) {
  if (asset.state !== "uploaded") {
    throw new Error(`${asset.name} is in unexpected state ${asset.state}`);
  }
  if (Number(asset.size) !== wanted.size) {
    throw new Error(
      `${asset.name} size mismatch: expected ${wanted.size}, received ${asset.size}`,
    );
  }
  const expectedDigest = `sha256:${wanted.sha256}`;
  if (asset.digest !== expectedDigest) {
    throw new Error(
      `${asset.name} digest mismatch: expected ${expectedDigest}, received ${asset.digest}`,
    );
  }
}
