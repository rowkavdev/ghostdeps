import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
export const coreJsVersion: string = _require('core-js/package.json').version

let pnp: typeof import('pnpapi') | undefined
try {
  pnp = createRequire(import.meta.url)('pnpapi')
} catch {}
export { pnp }
