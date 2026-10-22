import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('./install-display.sh', import.meta.url));
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Package the unchanged installer with its release identity and checksum. */
export function packageDisplayRelease(outputDir, tag, commit) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || '') || tag !== `v${version}`) {
    throw new Error('The display release tag must match package.json.');
  }
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Supply the full release commit SHA.');
  if (!outputDir) throw new Error('Supply an output directory for the display assets.');
  const installer = fs.readFileSync(source);
  const sha256 = createHash('sha256').update(installer).digest('hex');
  const manifest = {
    schema: 1,
    release_tag: tag,
    commit,
    installer: { name: 'install-display.sh', sha256 },
    checksum_file: 'install-display.sh.sha256',
  };
  const directory = path.resolve(outputDir);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'install-display.sh'), installer, { flag: 'wx', mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'install-display.sh.sha256'), `${sha256}  install-display.sh\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'display-installer.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: node scripts/package-display-release.js OUTPUT_DIR TAG COMMIT');
    console.log(JSON.stringify(packageDisplayRelease(...process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
