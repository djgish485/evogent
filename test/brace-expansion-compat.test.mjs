import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkoutRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const preloadPath = path.join(
  checkoutRoot,
  "scripts",
  "brace-expansion-compat.cjs",
);

test("the secure brace-expansion release remains callable by legacy minimatch", () => {
  const probe = String.raw`
    const path = require("node:path");
    const eslintEntry = require.resolve("eslint");
    const minimatchEntry = require.resolve("minimatch", {
      paths: [path.dirname(eslintEntry)],
    });
    const legacyMinimatch = require(minimatchEntry);
    const bracePackage = require.resolve("brace-expansion/package.json", {
      paths: [path.dirname(minimatchEntry)],
    });
    const braceVersion = require(bracePackage).version;

    if (typeof legacyMinimatch !== "function") process.exit(2);
    if (!legacyMinimatch("source/file.js", "{source,test}/**/*.js")) process.exit(3);
    if (braceVersion !== "5.0.8") process.exit(4);
  `;

  const result = spawnSync(
    process.execPath,
    ["--require", preloadPath, "-e", probe],
    {
      cwd: checkoutRoot,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `compatibility probe failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});
