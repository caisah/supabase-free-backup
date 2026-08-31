import { readFileSync } from 'node:fs';

/**
 * Canonical runtime pin. The repository requires at least the Node.js
 * release recorded in `.node-version`; newer releases are accepted for
 * backwards compatibility.
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
 * Parse a semver string (e.g. 'v24.20.0') into [major, minor, patch].
 */
function parseVersion(version) {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid version format: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Fail unless the running Node.js release is at least the pinned one.
 * Accepts the pinned version and any newer release.
 */
export function assertNodeVersion({ version = process.version } = {}) {
  const [reqMajor, reqMinor, reqPatch] = parseVersion(REQUIRED_NODE_VERSION_LABEL);
  const [curMajor, curMinor, curPatch] = parseVersion(version);

  const isOlder =
    curMajor < reqMajor ||
    (curMajor === reqMajor && curMinor < reqMinor) ||
    (curMajor === reqMajor && curMinor === reqMinor && curPatch < reqPatch);

  if (isOlder) {
    throw new Error(
      `Fragtrack backup requires Node.js >= ${REQUIRED_NODE_VERSION}; running ${version}. ` +
        `Upgrade Node.js (see .node-version) and re-run.`,
    );
  }
  return version;
}
