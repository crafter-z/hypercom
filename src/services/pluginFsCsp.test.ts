import { describe, expect, it } from 'vitest';
import configSource from '../../src-tauri/tauri.conf.json?raw';

const config = JSON.parse(configSource) as { app: { security: { csp: string; devCsp: string } } };
function connectSources(csp: string): string[] {
  const directive = csp.split(';').map(part => part.trim().split(/\s+/)).find(parts => parts[0] === 'connect-src');
  if (!directive) throw new Error('missing explicit connect-src policy');
  return directive.slice(1).sort();
}

describe('raw plugin file IPC CSP', () => {
  const ipc = ["'self'", 'ipc:', 'http://ipc.localhost', 'https://ipc.localhost'];
  it('allows the actual Tauri raw transport without opening arbitrary network origins', () => {
    expect(connectSources(config.app.security.csp)).toEqual([...ipc].sort());
  });
  it('keeps development HMR as the only extra connection source', () => {
    expect(connectSources(config.app.security.devCsp)).toEqual([...ipc, 'ws://localhost:1420'].sort());
  });
});
