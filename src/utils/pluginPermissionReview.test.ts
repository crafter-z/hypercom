import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import type { PluginView } from '../types';
import {
  capabilityDelta, effectivePermissions, groupedPermissions, initialReviewSelection,
  permissionDelta, reviewablePermissions, reviewStillApplies,
} from './pluginPermissionReview';

function installation(permissions: string[], grantedPermissions: string[] = []): PluginView {
  return {
    id: 'demo', dir: 'plugins/demo', installGeneration: 'install-a', enabled: false, installedAt: null,
    manifest: { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: '1.0', entry: 'main.js', description: '', permissions },
    manifestError: null,
    knownPermissions: ['terminal:read', 'rx:bytes', 'serial:send', 'serial:control', 'fs:open-dir', 'fs:export-dir', 'fs:write-dir', 'http:request', 'shell:execute', 'control:expose'],
    declaredPermissions: permissions,
    grantedPermissions,
  };
}

describe('plugin permission review', () => {
  it('never treats technical IDs from a stale grant or an unsupported declaration as a new capability', () => {
    const plugin = installation(['terminal:read', 'terminal:read', 'future:unknown', 'shell:execute'], ['terminal:read', 'fs:write-dir']);
    plugin.declaredPermissions = [...plugin.declaredPermissions, 'fs:open-dir'];
    expect(reviewablePermissions(plugin)).toEqual(['terminal:read', 'shell:execute']);
    expect(effectivePermissions(plugin)).toEqual(['terminal:read']);
    expect(initialReviewSelection(plugin, true)).toEqual(['terminal:read']);
    expect(initialReviewSelection(plugin, false)).toEqual(['terminal:read']);
  });

  it('groups one task without treating read, export, and destructive file writes as interchangeable', () => {
    const plugin = installation(['fs:open-dir', 'fs:export-dir', 'fs:write-dir', 'rx:bytes'], ['fs:open-dir']);
    expect(groupedPermissions(reviewablePermissions(plugin))).toEqual([
      { group: 'observe', permissions: ['rx:bytes'] },
      { group: 'files', permissions: ['fs:open-dir', 'fs:export-dir', 'fs:write-dir'] },
    ]);
    expect(initialReviewSelection(plugin, false)).toEqual(['fs:open-dir']);
    expect(permissionDelta(effectivePermissions(plugin), ['fs:export-dir'])).toEqual({ added: ['fs:export-dir'], removed: ['fs:open-dir'] });
  });

  it('reports capability changes even when the marketplace id and version match', () => {
    const preview = installation(['serial:send', 'http:request', 'terminal:read']).manifest!;
    const actual = installation(['serial:send', 'http:request', 'shell:execute']).manifest!;
    preview.serial = { portWhitelist: [] };
    actual.http = { urlWhitelist: ['https://example.test/*'] };
    expect(capabilityDelta(preview, actual)).toEqual({
      added: ['shell:execute'], removed: ['terminal:read'], serialScopeChanged: true, httpScopeChanged: true, trustChanged: false,
    });
    expect(capabilityDelta(actual, { ...actual, permissions: [...actual.permissions].reverse() })).toEqual({
      added: [], removed: [], serialScopeChanged: false, httpScopeChanged: false, trustChanged: false,
    });
  });

  it('invalidates decisions when the reviewed identity, permission scope, or baseline no longer matches', () => {
    const reviewed = installation(['serial:send', 'terminal:read'], ['terminal:read']);
    expect(reviewStillApplies(reviewed, { ...reviewed })).toBe(true);
    expect(reviewStillApplies(reviewed, { ...reviewed, enabled: true })).toBe(false);
    expect(reviewStillApplies(reviewed, { ...reviewed, installGeneration: 'install-b' })).toBe(false);
    expect(reviewStillApplies(reviewed, { ...reviewed, grantedPermissions: [] })).toBe(false);
    expect(reviewStillApplies(reviewed, { ...reviewed, manifest: { ...reviewed.manifest!, serial: { portWhitelist: [] } } })).toBe(false);
  });

  it('groups control:expose under external and includes it in initial install selection', () => {
    const plugin = installation(['control:expose', 'terminal:read', 'shell:execute']);
    expect(groupedPermissions(reviewablePermissions(plugin))).toEqual([
      { group: 'observe', permissions: ['terminal:read'] },
      { group: 'external', permissions: ['control:expose', 'shell:execute'] },
    ]);
    expect(initialReviewSelection(plugin, true)).toEqual(['control:expose', 'terminal:read']);
  });

  it('keeps review translations in matching order with matching placeholders', () => {
    function strings(language: string) {
      return Object.entries(i18n.getResourceBundle(language, 'translation') as Record<string, string>)
        .filter(([key]) => key.startsWith('plugins.review.'))
        .map(([key, text]) => [key, [...text.matchAll(/\{\{\w+\}\}/g)].map(match => match[0]).sort()]);
    }
    expect(strings('zh-CN').length).toBeGreaterThan(40);
    expect(strings('zh-CN')).toEqual(strings('en-US'));
  });
});
