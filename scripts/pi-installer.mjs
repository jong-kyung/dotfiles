import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const agent = join(process.env.HOME, '.pi/agent');
const packageName = '@earendil-works/pi-coding-agent';

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function managed(root) {
  const path = join(root, 'managed-install.json');
  if (!present(path)) return false;
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  if (marker.kind !== 'pi-managed-install' || marker.schemaVersion !== 1 || marker.layout !== 'releases-v1') {
    throw new Error(`Invalid managed Pi marker: ${path}`);
  }
  return true;
}

function inspect(command) {
  if (!command) {
    command = join(agent, 'bin/pi');
    if (!present(command) && !present(join(agent, 'install/managed-install.json'))) return '';
  }
  if (basename(command) !== 'pi') throw new Error(`Unrecognized Pi command: ${command}`);
  const actual = realpathSync(command);
  accessSync(actual, constants.X_OK);
  if (managed(dirname(command))) return resolve(command);
  if (basename(actual) === 'pi' && basename(dirname(actual)) === 'bin' && managed(join(dirname(dirname(actual)), 'install'))) return actual;

  // shortcut: migrate npm bin links only, add shim support when ownership can be verified.
  if (basename(dirname(command)) === 'bin') {
    const pkg = join(dirname(dirname(command)), 'lib/node_modules', packageName);
    const manifest = join(pkg, 'package.json');
    if (present(manifest)) {
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      const bin = typeof data.bin === 'string' ? data.bin : data.bin?.pi;
      if (data.name === packageName && typeof bin === 'string' && actual === realpathSync(resolve(pkg, bin))) {
        if (present(join(agent, 'install/managed-install.json'))) {
          throw new Error('An npm Pi shadows an existing managed installation. Resolve the duplicate installations manually.');
        }
        return '';
      }
    }
  }
  throw new Error(`Cannot prove Pi ownership at ${command}. Resolve this installation manually before retrying.`);
}

async function run(script) {
  // A separate POSIX session prevents upstream's /dev/tty prompts, not just stdin reads.
  const child = spawn('/bin/sh', [script], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PI_LEGACY_INSTALL: '0', TERM: 'dumb' },
  });
  let interrupted;
  const forward = signal => {
    interrupted = signal;
    try {
      // Shell background jobs may ignore SIGINT, so terminate the whole installer group.
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    const stopped = interrupted || signal;
    return stopped ? 128 + osConstants.signals[stopped] : code;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

try {
  if (process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR !== agent) {
    throw new Error('Custom PI_CODING_AGENT_DIR is not supported.');
  }
  if (process.env.PI_MANAGED_INSTALL_ROOT && resolve(process.env.PI_MANAGED_INSTALL_ROOT) !== join(agent, 'install')) {
    throw new Error('Custom PI_MANAGED_INSTALL_ROOT is not supported.');
  }
  const [mode, value] = process.argv.slice(2);
  if (mode === 'inspect') {
    const command = inspect(value);
    if (command) console.log(command);
  } else if (mode === 'run' && value) {
    process.exitCode = await run(value);
  } else {
    throw new Error('Expected inspect <pi-path> or run <installer-script>.');
  }
} catch (error) {
  console.error(`Pi setup failed: ${error.message}`);
  process.exitCode = 1;
}
