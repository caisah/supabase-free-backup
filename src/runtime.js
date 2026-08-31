import { readFileSync } from 'node:fs';

/**
 * Canonical runtime pin. The repository runs only on the exact Node.js
 * release recorded in `.node-version`; any other release is rejected.
 * `.node-version` is the single source of truth: CI reads it directly
 * (`node-version-file`) and `package.json` `engines.node` only mirrors it —
 * `runtime.test.js` fails if any mirror drifts.
 */
export const REQUIRED_NODE_VERSION = readFileSync(
  new URL('../.node-version', import.meta.url),
  'utf8',
).trim();
export const REQUIRED_NODE_VERSION_LABEL = `v${REQUIRED_NODE_VERSION}`;

export function currentNodeVersion() {
  return process.version;
}

/**
 * Fail unless the running Node.js release is exactly the pinned one.
 * Never silently run on an older or unreviewed later release.
 */
export function assertNodeVersion({ version = process.version } = {}) {
  if (version !== REQUIRED_NODE_VERSION_LABEL) {
    throw new Error(
      `Fragtrack backup requires Node.js ${REQUIRED_NODE_VERSION} exactly; running ${version}. ` +
        `Install the pinned release (see .node-version) and re-run.`,
    );
  }
  return version;
}
