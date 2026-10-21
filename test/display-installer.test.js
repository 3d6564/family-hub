import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('standalone display installation, repeat runs, updates, and recovery', () => {
  const script = fileURLToPath(new URL('./display-installer.sh', import.meta.url));
  const result = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
