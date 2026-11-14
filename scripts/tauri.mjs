import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const env = { ...process.env };

// The repository and its default target directory may carry a Low Mandatory
// Level label on Windows. A low-integrity executable cannot write to the
// normal-integrity %APPDATA% directory, which makes startup fail while
// creating config.lock and the diagnostic log. Keep an explicit user override,
// otherwise place Cargo artifacts in a normal-integrity per-user directory.
if (process.platform === 'win32' && !env.CARGO_TARGET_DIR) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  env.CARGO_TARGET_DIR = path.join(localAppData, 'HyperComBuild', 'target');
  console.log(`[tauri] Using external Cargo target directory: ${env.CARGO_TARGET_DIR}`);
}

const require = createRequire(import.meta.url);
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`[tauri] Failed to start CLI: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[tauri] CLI terminated by signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
