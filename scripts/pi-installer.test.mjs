import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = join(root, 'scripts/pi-installer.mjs');
const marker = { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' };
const packageName = '@earendil-works/pi-coding-agent';

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pi-installer-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi/agent') };
  delete env.PI_MANAGED_INSTALL_ROOT;
  const put = (name, content, executable = false) => {
    const path = join(home, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (executable) chmodSync(path, 0o755);
    return path;
  };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { env, encoding: 'utf8' });
  const managed = () => {
    put('.pi/agent/install/managed-install.json', JSON.stringify(marker));
    return put('.pi/agent/bin/pi', '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/pi-calls"\n', true);
  };
  const legacy = () => {
    const pkg = `legacy/lib/node_modules/${packageName}`;
    put(`${pkg}/package.json`, JSON.stringify({ name: packageName, bin: { pi: 'dist/cli.js' } }));
    const bin = put(`${pkg}/dist/cli.js`, '#!/bin/sh\nexit 99\n', true);
    mkdirSync(join(home, 'legacy/bin'), { recursive: true });
    const command = join(home, 'legacy/bin/pi');
    symlinkSync(bin, command);
    return command;
  };
  return { home, env, put, run, managed, legacy };
}

test('inspection skips managed direct and symlink commands, including a dormant default install', t => {
  const f = fixture(t);
  const pi = f.managed();
  const link = join(f.home, 'pi');
  symlinkSync(pi, link);
  for (const command of [pi, link, '']) {
    const result = f.run('inspect', command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pi);
  }
});

test('inspection skips a launcher beside its managed marker', t => {
  const f = fixture(t);
  f.put('old-install/managed-install.json', JSON.stringify(marker));
  const pi = f.put('old-install/pi', '#!/bin/sh\nexit 0\n', true);
  assert.equal(f.run('inspect', pi).stdout.trim(), pi);
});

test('inspection refuses an npm CLI shadowing an existing managed install', t => {
  const f = fixture(t);
  f.managed();
  const result = f.run('inspect', f.legacy());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate installations/);
});

test('inspection allows a missing CLI and a proven global npm CLI', t => {
  const f = fixture(t);
  for (const command of ['', f.legacy()]) {
    const result = f.run('inspect', command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('inspection refuses unrelated commands even when the npm package exists', t => {
  const f = fixture(t);
  const command = f.legacy();
  rmSync(command);
  f.put('legacy/bin/pi', '#!/bin/sh\nexit 0\n', true);
  const result = f.run('inspect', command);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership|unrecognized/i);
});

test('inspection refuses invalid markers, broken links, and symlink loops', t => {
  const f = fixture(t);
  const pi = f.managed();
  for (const value of ['{', JSON.stringify({ ...marker, schemaVersion: 2 })]) {
    f.put('.pi/agent/install/managed-install.json', value);
    assert.notEqual(f.run('inspect', pi).status, 0);
  }
  rmSync(pi);
  symlinkSync('missing', pi);
  assert.notEqual(f.run('inspect', pi).status, 0);
  rmSync(pi);
  symlinkSync('pi', pi);
  assert.notEqual(f.run('inspect', pi).status, 0);
});

test('runner has no controlling terminal and forces managed installation', t => {
  const f = fixture(t);
  f.env.PI_LEGACY_INSTALL = '1';
  const script = f.put('probe.sh', 'if ( : <>/dev/tty ) 2>/dev/null; then exit 91; fi\n[ "$PI_LEGACY_INSTALL" != 1 ] || exit 92\nprintf ok\n');
  const result = f.run('run', script);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok');
});

test('runner propagates failures and rejects a custom managed root', t => {
  const f = fixture(t);
  assert.equal(f.run('run', f.put('failure.sh', 'exit 7\n')).status, 7);
  assert.notEqual(f.run('run', join(f.home, 'missing.sh')).status, 0);
  f.env.PI_MANAGED_INSTALL_ROOT = join(f.home, 'elsewhere');
  assert.notEqual(f.run('run', f.put('unused.sh', 'exit 0\n')).status, 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`runner cancels on ${signal} and waits for the installer to stop`, { timeout: 10000 }, async t => {
    const f = fixture(t);
    const script = f.put('wait.sh', 'trap \'printf stopped > "$HOME/stopped"; exit 0\' INT TERM\nprintf ready > "$HOME/ready"\nwhile :; do sleep 1; done\n');
    const child = spawn(process.execPath, [helper, 'run', script], { env: f.env, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    for (let i = 0; i < 200 && !existsSync(join(f.home, 'ready')); i++) await delay(10);
    assert.ok(existsSync(join(f.home, 'ready')), 'installer started');
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.equal(readFileSync(join(f.home, 'stopped'), 'utf8'), 'stopped');
  });
}

for (const state of ['missing', 'legacy', 'managed', 'unknown', 'failure']) {
  test(`Pi stage handles ${state} installation without a real installer`, t => {
    const f = fixture(t);
    if (state === 'managed') f.managed();
    if (state === 'legacy') f.legacy();
    if (state === 'unknown') f.put('legacy/bin/pi', '#!/bin/sh\nexit 99\n', true);
    f.put('.pi/agent/extensions/herdr-agent-state.ts', '');
    f.put('installer.sh', `set -eu
printf installed > "$HOME/installer-called"
mkdir -p "$HOME/.pi/agent/bin" "$HOME/.pi/agent/install"
printf '%s' '${JSON.stringify(marker)}' > "$HOME/.pi/agent/install/managed-install.json"
cat > "$HOME/.pi/agent/bin/pi" <<'CLI'
#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/pi-calls"
CLI
chmod +x "$HOME/.pi/agent/bin/pi"
`);
    if (state === 'failure') f.put('installer.sh', 'exit 7\n');
    const script = `set -euo pipefail
ROOT="$1"
PI_PACKAGES=
source "$ROOT/scripts/setup/common.sh"
source "$ROOT/scripts/setup/pi.sh"
ai_prepare() { :; }
merge_json() { :; }
install_skills() { :; }
copy_file() { :; }
codegraph() { :; }
installer() {
  [ "$1" = https://pi.dev/install.sh ]
  "$2" "$HOME/installer.sh"
}
pi_stage
`;
    f.env.PATH = `${join(f.home, 'legacy/bin')}:${dirname(process.execPath)}:/usr/bin:/bin`;
    const result = spawnSync('/bin/bash', ['-c', script, 'test', resolve(root)], { env: f.env, encoding: 'utf8' });
    if (state === 'unknown' || state === 'failure') {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(f.home, 'pi-calls')), false);
      assert.equal(existsSync(join(f.home, 'installer-called')), false);
      return;
    }
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(existsSync(join(f.home, 'installer-called')), state !== 'managed');
    assert.match(readFileSync(join(f.home, 'pi-calls'), 'utf8'), /mcp --help\n--version\nlist\n/);
  });
}
