import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json');

/** Return non-sensitive release metadata. Local builds stay marked as development. */
export function releaseInfo(env = process.env) {
  const published = env.FAMILY_HUB_CHANNEL === 'release' && env.FAMILY_HUB_VERSION;
  return {
    version: published ? env.FAMILY_HUB_VERSION : pkg.version,
    revision: published ? env.FAMILY_HUB_REVISION || null : null,
    created: published ? env.FAMILY_HUB_CREATED || null : null,
    channel: published ? 'release' : 'development',
  };
}
