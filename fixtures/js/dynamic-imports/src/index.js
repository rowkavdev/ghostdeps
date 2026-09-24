// Dynamic import: the dependency is used, but only visible at runtime.
export async function group(ids) {
  const { chunk } = await import("lodash-es");
  return chunk(ids, 2);
}
