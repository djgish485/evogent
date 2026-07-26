"use strict";

const Module = require("node:module");

const patchKey = Symbol.for("evogent.brace-expansion-commonjs-compat");

if (!globalThis[patchKey]) {
  const originalLoad = Module._load;

  Module._load = function loadWithBraceExpansionCompatibility(
    request,
    parent,
    isMain,
  ) {
    const loaded = originalLoad.call(this, request, parent, isMain);

    if (
      request !== "brace-expansion" ||
      typeof loaded === "function" ||
      typeof loaded?.expand !== "function"
    ) {
      return loaded;
    }

    const callable = (pattern, options) => loaded.expand(pattern, options);
    return Object.assign(callable, loaded);
  };

  globalThis[patchKey] = true;
}
