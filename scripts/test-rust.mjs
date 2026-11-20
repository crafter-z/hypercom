import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function removeOwnedTemp(directory, cacheRoot) {
  // Only remove the unique directory this invocation created, never a computed
  // parent or a replacement link. The cache root is canonical before creation.
  if (path.dirname(directory) !== cacheRoot || !path.basename(directory).startsWith('rust-tests-')) {
    throw new Error(`Refusing to clean an unexpected test directory: ${directory}`);
  }
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`Refusing to clean a replaced test directory: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}

/** Keep fixtures local to the test run, without changing the caller's environment.
 * Windows executables built in a Low Mandatory Level workspace inherit that level
 * (see tauri.mjs), so they cannot write to the ordinary system %TEMP% directory.
 * A private workspace directory also isolates fixed fixture names across runners.
 */
export function withRustTestTemp(env, run) {
  const cachePath = path.join(projectRoot, '.npm-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  const cacheRoot = fs.realpathSync(cachePath);
  const directory = fs.mkdtempSync(path.join(cacheRoot, 'rust-tests-'));
  console.log(`[test:rust] Temporary fixtures: ${directory}`);
  try {
    return run(directory, { ...env, TEMP: directory, TMP: directory, TMPDIR: directory });
  } finally {
    removeOwnedTemp(directory, cacheRoot);
  }
}

export function runCargo(args, { env, launch = spawnSync, stdio = 'inherit' }) {
  const [subcommand, ...rest] = args;
  const result = launch('cargo', [
    subcommand, '--manifest-path', path.join(projectRoot, 'src-tauri', 'Cargo.toml'), ...rest,
  ], { cwd: projectRoot, env, stdio });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runRustTests(args = [], { env = process.env, launch = spawnSync } = {}) {
  return withRustTestTemp(env, (_directory, childEnv) => runCargo(
    ['test', '--lib', ...args], { env: childEnv, launch },
  ));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runRustTests(process.argv.slice(2));
  } catch (error) {
    console.error(`[test:rust] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
