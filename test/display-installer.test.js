import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('standalone display installation, repeat runs, updates, and recovery', () => {
  const script = fileURLToPath(new URL('./display-installer.sh', import.meta.url));
  const result = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('display installer provides private, parseable preview and error results', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'family-hub-display-json-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'chromium'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\ncase "$2" in\nshow) exit 0 ;;\nis-active|is-enabled) exit 1 ;;\n*) exit 99 ;;\nesac\n', { mode: 0o755 });
  const installer = fileURLToPath(new URL('../scripts/install-display.sh', import.meta.url));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CONFIG_DIRS: path.join(home, 'system-config'), XDG_CURRENT_DESKTOP: 'labwc', SITE_URL: '', PATH: `${bin}:${process.env.PATH}` };
  const url = 'https://private-display.example/';
  const preview = spawnSync('bash', [installer, '--check', '--json', url], { env, encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.status, 'ok');
  assert.equal(plan.mode, 'check');
  assert.equal(plan.changed, false);
  assert.equal(plan.would_change, true);
  assert.equal(plan.installed_version, 'none');
  assert.equal(plan.service_action, 'start');
  assert.equal(preview.stdout.includes(url), false);
  assert.equal(fs.existsSync(env.XDG_CONFIG_HOME), false);
  const invalid = spawnSync('bash', [installer, '--json', '--unknown'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).status, 'error');
  assert.equal(fs.existsSync(env.XDG_CONFIG_HOME), false);
});
