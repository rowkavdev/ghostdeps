// Regression from vite plugin-legacy: these packages are named in strings the
// plugin adds to generated bundles, never imported by this module itself.
const polyfills = new Set();
polyfills.add("regenerator-runtime/runtime.js");

export const loader = `import "systemjs/dist/s.min.js";`;
export { polyfills };
