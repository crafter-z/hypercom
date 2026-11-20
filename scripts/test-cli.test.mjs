import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCliTests } from './test-cli.mjs';

function reportArtifact(options, name = 'hypercom-cli') {
  const exe = path.join(options.env.TEMP, `${name}.exe`);
  fs.writeFileSync(exe, 'fixture');
  fs.writeFileSync(options.stdio[1], JSON.stringify({
    reason: 'compiler-artifact', target: { name, kind: ['bin'] }, executable: exe,
  }) + '\n');
  return exe;
}

test('CLI runner uses the exact artifact Cargo reports and runs the two distinct suites', () => {
  const env = { HYPERCOM_TEST_CLI_BIN: 'stale', CARGO_TARGET_DIR: 'alternate-target' };
  const calls = [];
  let exe;
  assert.equal(runCliTests(['--locked'], { env, report() {}, launch(command, args, options) {
    calls.push({ command, args, options });
    if (args[0] === 'build') exe = reportArtifact(options);
    if (args.includes('--lib')) fs.writeFileSync(options.stdio[1], 'test result: ok. 5 passed; 0 failed\n');
    return { status: 0 };
  } }), 0);
  assert.deepEqual(calls.map(({ args }) => [args[0], ...args.slice(3)]), [
    ['build', '--bin', 'hypercom-cli', '--message-format=json-render-diagnostics', '--locked'],
    ['test', '--bin', 'hypercom-cli', '--locked'],
    ['test', '--lib', '--locked', 'cli_binary_', '--', '--ignored', '--format', 'pretty'],
  ]);
  assert.ok(calls.every(({ command, options }) => command === 'cargo' && options.env.CARGO_TARGET_DIR === 'alternate-target'));
  assert.equal(calls[2].options.env.HYPERCOM_TEST_CLI_BIN, exe);
  assert.equal(env.HYPERCOM_TEST_CLI_BIN, 'stale');
  assert.equal(fs.existsSync(exe), false);
});

test('CLI runner does not run suites if the binary failed to build', () => {
  let calls = 0;
  assert.equal(runCliTests([], { launch() {
    calls += 1;
    return { status: 101 };
  } }), 101);
  assert.equal(calls, 1);
});

test('CLI runner rejects a build which reports no matching binary', () => {
  assert.throws(() => runCliTests([], { launch(_command, _args, options) {
    reportArtifact(options, 'hypercom');
    return { status: 0 };
  } }), /did not report exactly one executable/);
});

test('CLI runner fails if the runtime suite filter matches no tests', () => {
  assert.throws(() => runCliTests([], { report() {}, launch(_command, args, options) {
    if (args[0] === 'build') reportArtifact(options);
    if (args.includes('--lib')) fs.writeFileSync(options.stdio[1], 'test result: ok. 0 passed; 0 failed\n');
    return { status: 0 };
  } }), /No CLI binary contract tests ran/);
});
