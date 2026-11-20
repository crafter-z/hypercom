import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCargo, withRustTestTemp } from './test-rust.mjs';

const CLI = 'hypercom-cli';

function findCliArtifact(messages) {
  const candidates = new Set();
  for (const line of messages.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    const artifact = JSON.parse(line);
    if (artifact.reason === 'compiler-artifact' && artifact.target?.name === CLI &&
        artifact.target.kind.includes('bin') && typeof artifact.executable === 'string') {
      candidates.add(artifact.executable);
    }
  }
  const [exe] = candidates;
  if (candidates.size !== 1 || !path.isAbsolute(exe) || !fs.statSync(exe).isFile()) {
    throw new Error(`Cargo did not report exactly one executable for ${CLI}`);
  }
  return exe;
}

function captureCargo(args, file, options) {
  // A file descriptor rather than a pipe also works in the Windows harness.
  const fd = fs.openSync(file, 'wx');
  let status;
  try {
    status = runCargo(args, { ...options, stdio: ['inherit', fd, 'inherit'] });
  } finally {
    fs.closeSync(fd);
  }
  return { status, output: fs.readFileSync(file, 'utf8') };
}

/** Run both the CLI unit tests and the real CLI executable against a fake driver. */
export function runCliTests(args = [], { env = process.env, launch, report = output => process.stdout.write(output) } = {}) {
  if (args.some(arg => arg !== '--locked' && arg !== '--offline')) {
    throw new Error('Usage: npm run test:cli -- [--locked] [--offline]');
  }
  return withRustTestTemp(env, (directory, childEnv) => {
    // Get the exact path from Cargo; do not assume default target-dir or host triple.
    const build = captureCargo(['build', '--bin', CLI, '--message-format=json-render-diagnostics', ...args],
      path.join(directory, 'cli-cargo-artifacts.ndjson'), { env: childEnv, launch });
    if (build.status !== 0) return build.status;
    const executable = findCliArtifact(build.output);
    const unit = runCargo(['test', '--bin', CLI, ...args], { env: childEnv, launch });
    if (unit !== 0) return unit;
    const contract = captureCargo(['test', '--lib', ...args, 'cli_binary_', '--', '--ignored', '--format', 'pretty'],
      path.join(directory, 'cli-contract.txt'), { env: { ...childEnv, HYPERCOM_TEST_CLI_BIN: executable }, launch });
    report(contract.output);
    // libtest exits 0 when a filter matches nothing. Do not report a false pass.
    if (contract.status === 0 && !/^test result: ok\. [1-9]\d* passed;/m.test(contract.output)) {
      throw new Error('No CLI binary contract tests ran');
    }
    return contract.status;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCliTests(process.argv.slice(2));
  } catch (error) {
    console.error(`[test:cli] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
