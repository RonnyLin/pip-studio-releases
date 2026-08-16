import { readFile } from "node:fs/promises";

const [, , expectedArg, actualArg, tagArg] = process.argv;
if (!expectedArg || !actualArg || !tagArg) {
  throw new Error(
    "Usage: node scripts/verify-uploaded-release.mjs <expected-json> <actual-json> <tag>",
  );
}

const expected = JSON.parse(await readFile(expectedArg, "utf8"));
const actual = JSON.parse(await readFile(actualArg, "utf8"));

if (actual.tag_name !== tagArg) {
  throw new Error(
    `Release tag mismatch: expected ${tagArg}, received ${actual.tag_name}`,
  );
}

const actualAssets = new Map(actual.assets.map((asset) => [asset.name, asset]));

if (actualAssets.size !== expected.assets.length) {
  throw new Error(
    `Asset count mismatch: expected ${expected.assets.length}, received ${actualAssets.size}`,
  );
}

for (const asset of expected.assets) {
  const uploaded = actualAssets.get(asset.fileName);
  if (uploaded === undefined) {
    throw new Error(`Uploaded release is missing ${asset.fileName}`);
  }
  if (uploaded.state !== "uploaded") {
    throw new Error(
      `${asset.fileName} is in unexpected state ${uploaded.state}`,
    );
  }
  if (Number(uploaded.size) !== asset.size) {
    throw new Error(
      `${asset.fileName} size mismatch: expected ${asset.size}, received ${uploaded.size}`,
    );
  }
  const expectedDigest = `sha256:${asset.sha256}`;
  if (uploaded.digest !== expectedDigest) {
    throw new Error(
      `${asset.fileName} digest mismatch: expected ${expectedDigest}, received ${uploaded.digest}`,
    );
  }
}

console.log(
  `Verified ${expected.assets.length} uploaded assets for ${tagArg}.`,
);
