import { releaseInfo } from './release.js';

const releasePattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const notesPrefix = 'https://github.com/3d6564/family-hub/releases/';
const latestRelease = 'https://api.github.com/repos/3d6564/family-hub/releases/latest';

function parseVersion(value) {
  const match = releasePattern.exec(String(value || ''));
  return match ? { parts: match.slice(1, 4).map(Number), pre: match[4] || '' } : null;
}

/** Return negative when installed is older than latest. */
export function compareVersions(installed, latest) {
  const left = parseVersion(installed);
  const right = parseVersion(latest);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Check GitHub for a newer release without installing it. Checks are off by default. */
export function createUpdateChecker({ fetch: fetchImpl = globalThis.fetch, env = process.env, now = Date.now, info = releaseInfo } = {}) {
  let cache = null;
  let etag = '';
  let nextTry = 0;
  return {
    async status() {
      const installed = info(env).version;
      if (!['1', 'true'].includes(env.FAMILY_HUB_UPDATE_CHECK)) return { enabled: false, installed };
      if (cache && now() < nextTry) return { ...cache, installed };
      const unavailable = { enabled: true, installed, state: 'unavailable' };
      try {
        const headers = { accept: 'application/vnd.github+json', 'user-agent': 'family-hub' };
        if (etag) headers['if-none-match'] = etag;
        if (env.FAMILY_HUB_UPDATE_TOKEN) headers.authorization = `Bearer ${env.FAMILY_HUB_UPDATE_TOKEN}`;
        const response = await fetchImpl(latestRelease, { headers, signal: AbortSignal.timeout(5000) });
        if (response.status === 304 && cache) {
          nextTry = now() + 6 * 60 * 60 * 1000;
          return { ...cache, installed };
        }
        if (!response.ok) {
          nextTry = now() + 60 * 60 * 1000;
          return cache ? { ...cache, installed } : unavailable;
        }
        const body = await response.json();
        const latest = String(body.tag_name || '').replace(/^v/, '');
        if (body.draft || body.prerelease || !parseVersion(latest)) {
          nextTry = now() + 60 * 60 * 1000;
          return cache ? { ...cache, installed } : unavailable;
        }
        etag = response.headers.get('etag') || '';
        cache = {
          enabled: true,
          installed,
          latest,
          updateAvailable: compareVersions(installed, latest) < 0,
          notesUrl: typeof body.html_url === 'string' && body.html_url.startsWith(notesPrefix) ? body.html_url : null,
          state: 'ok',
        };
        nextTry = now() + 6 * 60 * 60 * 1000;
        return cache;
      } catch {
        nextTry = now() + 60 * 60 * 1000;
        return cache ? { ...cache, installed } : unavailable;
      }
    },
  };
}
