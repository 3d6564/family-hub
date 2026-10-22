import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageDisplayRelease } from '../scripts/package-display-release.js';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('display release assets retain the tested installer bytes and verified identity', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-hub-display-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const commit = 'a'.repeat(40);
  const manifest = packageDisplayRelease(directory, `v${version}`, commit);
  const installer = fs.readFileSync(path.join(directory, 'install-display.sh'));
  assert.deepEqual(installer, fs.readFileSync(new URL('../scripts/install-display.sh', import.meta.url)));
  assert.equal(manifest.release_tag, `v${version}`);
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.installer.sha256, createHash('sha256').update(installer).digest('hex'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'display-installer.json'), 'utf8')), manifest);
  assert.equal(fs.readFileSync(path.join(directory, 'install-display.sh.sha256'), 'utf8'), `${manifest.installer.sha256}  install-display.sh\n`);
  assert.equal(spawnSync('bash', ['-n', path.join(directory, 'install-display.sh')]).status, 0);
  assert.throws(() => packageDisplayRelease(directory, `v${version}`, commit), /EEXIST/);
});

test('invalid release identity is rejected before creating output', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'family-hub-release-invalid-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'assets');
  assert.throws(() => packageDisplayRelease(output, 'v999.0.0', 'a'.repeat(40)), /match package.json/);
  assert.throws(() => packageDisplayRelease(output, `v${version}`, '../bad-commit'), /full release commit/);
  assert.equal(fs.existsSync(output), false);
});
