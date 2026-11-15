import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runRustTests } from './test-rust.mjs';

function captureLaunch(status = 0) {
  let invocation;
  return {
    launch(command, args, options) {
      invocation = { command, args, options };
      assert.equal(fs.statSync(options.env.TEMP).isDirectory(), true);
      fs.writeFileSync(path.join(options.env.TEMP, 'fixture.txt'), 'test data');
      return { status };
    },
    get invocation() { return invocation; },
  };
}

test('sets a private workspace temp for Cargo and preserves the caller environment', () => {
  const env = { TEMP: 'original-temp', TMP: 'original-tmp', TMPDIR: 'original-tmpdir', CARGO_TARGET_DIR: 'custom-target', PATH: process.env.PATH };
  const original = { ...env };
  const child = captureLaunch();
  assert.equal(runRustTests(['commands::file::tests', '--', '--test-threads=1'], { env, launch: child.launch }), 0);
  assert.deepEqual(env, original);
  const { command, args, options } = child.invocation;
  assert.equal(command, 'cargo');
  assert.equal(options.stdio, 'inherit');
  assert.equal(options.env.CARGO_TARGET_DIR, 'custom-target');
  assert.equal(options.env.TEMP, options.env.TMP);
  assert.equal(options.env.TMP, options.env.TMPDIR);
  assert.equal(path.dirname(options.env.TEMP), fs.realpathSync(path.join(options.cwd, '.npm-cache')));
  assert.equal(args[0], 'test');
  assert.equal(args[1], '--manifest-path');
  assert.equal(args[2], path.join(options.cwd, 'src-tauri', 'Cargo.toml'));
  assert.deepEqual(args.slice(3), ['--lib', 'commands::file::tests', '--', '--test-threads=1']);
  assert.equal(fs.existsSync(options.env.TEMP), false);
});

test('propagates Cargo failures and still cleans fixtures', () => {
  const child = captureLaunch(101);
  assert.equal(runRustTests([], { launch: child.launch }), 101);
  assert.equal(fs.existsSync(child.invocation.options.env.TEMP), false);
});

test('cleans fixtures after a launch error', () => {
  let directory;
  assert.throws(() => runRustTests([], {
    launch(_command, _args, options) {
      directory = options.env.TEMP;
      return { error: new Error('Cargo unavailable') };
    },
  }), /Cargo unavailable/);
  assert.equal(fs.existsSync(directory), false);
});

test('reports interrupted Cargo as failure instead of success', () => {
  let directory;
  assert.equal(runRustTests([], {
    launch(_command, _args, options) {
      directory = options.env.TEMP;
      return { status: null, signal: 'SIGTERM' };
    },
  }), 1);
  assert.equal(fs.existsSync(directory), false);
});

test('gives separate invocations distinct fixture roots', () => {
  const first = captureLaunch();
  const second = captureLaunch();
  runRustTests([], { launch: first.launch });
  runRustTests([], { launch: second.launch });
  assert.notEqual(first.invocation.options.env.TEMP, second.invocation.options.env.TEMP);
});
