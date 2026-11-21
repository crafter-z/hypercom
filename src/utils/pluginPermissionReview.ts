import type { PluginManifestView, PluginView } from '../types';

// Groups explain tasks; only the individual permission IDs are grant units.
const permissionReviewGroups: Readonly<Record<string, readonly string[]>> = {
  observe: ['terminal:read', 'rx:bytes'],
  device: ['serial:send', 'serial:control'],
  files: ['fs:assets', 'fs:storage', 'fs:open', 'fs:open-dir', 'fs:export-dir', 'fs:save', 'fs:write-dir'],
  external: ['http:request', 'shell:open', 'shell:execute', 'clipboard'],
  workspace: ['terminal:write', 'notify', 'storage', 'ui:view', 'ui:tabs'],
};

export const LOCAL_EXECUTION_PERMISSION = 'shell:execute';

export function reviewablePermissions(plugin: PluginView): string[] {
  const manifest = plugin.manifest;
  if (!manifest || plugin.manifestError) return [];
  return [...new Set(plugin.declaredPermissions)].filter(permission =>
    plugin.knownPermissions.includes(permission) && manifest.permissions.includes(permission));
}

export function groupedPermissions(permissions: readonly string[]) {
  const grouped = Object.entries(permissionReviewGroups).map(([group, members]) => ({
    group, permissions: permissions.filter(permission => members.includes(permission)),
  }));
  const named = new Set(grouped.flatMap(group => group.permissions));
  grouped.push({ group: 'other', permissions: permissions.filter(permission => !named.has(permission)) });
  return grouped.filter(group => group.permissions.length > 0);
}

export function effectivePermissions(plugin: PluginView): string[] {
  return reviewablePermissions(plugin).filter(permission => plugin.grantedPermissions.includes(permission));
}

export function initialReviewSelection(plugin: PluginView, install: boolean): string[] {
  return install
    ? reviewablePermissions(plugin).filter(permission => permission !== LOCAL_EXECUTION_PERMISSION)
    : effectivePermissions(plugin);
}

export function permissionDelta(before: readonly string[], after: readonly string[]) {
  return {
    added: after.filter(permission => !before.includes(permission)),
    removed: before.filter(permission => !after.includes(permission)),
  };
}

export function hasTrustedViews(manifest: PluginManifestView | null): boolean {
  return manifest?.ui?.views?.some(view => view.mode === 'trusted-web') === true;
}

export function serialPortScope(manifest: PluginManifestView) {
  return manifest.serial?.portWhitelist ?? null;
}

export function httpUrlScope(manifest: PluginManifestView) {
  return manifest.http?.urlWhitelist ?? [];
}

function sameSet(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  const delta = permissionDelta(left, right);
  return delta.added.length === 0 && delta.removed.length === 0;
}

export function capabilityDelta(before: PluginManifestView, after: PluginManifestView) {
  const delta = permissionDelta([...new Set(before.permissions)], [...new Set(after.permissions)]);
  const serialRelevant = [before, after].some(manifest => manifest.permissions.some(permission =>
    permission === 'serial:send' || permission === 'serial:control'));
  const httpRelevant = [before, after].some(manifest => manifest.permissions.includes('http:request'));
  return {
    ...delta,
    serialScopeChanged: serialRelevant && !sameSet(serialPortScope(before), serialPortScope(after)),
    httpScopeChanged: httpRelevant && !sameSet(httpUrlScope(before), httpUrlScope(after)),
    trustChanged: hasTrustedViews(before) !== hasTrustedViews(after),
  };
}

export type PermissionReviewIntent = 'install' | 'enable' | 'manage';

export interface PluginPermissionDecision {
  plugin: PluginView;
  intent: PermissionReviewIntent;
  permissions: readonly string[];
  trustWeb: boolean;
}

/** Do not replay decisions against a changed installation, declaration, or grant baseline. */
export function reviewStillApplies(reviewed: PluginView, current: PluginView): boolean {
  if (reviewed.id !== current.id || !reviewed.installGeneration || reviewed.installGeneration !== current.installGeneration ||
      !reviewed.manifest || !current.manifest || reviewed.manifestError || current.manifestError ||
      reviewed.manifest.version !== current.manifest.version || reviewed.manifest.name !== current.manifest.name ||
      (reviewed.manifest.entry ?? '') !== (current.manifest.entry ?? '') || reviewed.enabled !== current.enabled ||
      Boolean(reviewed.trustedWebGranted) !== Boolean(current.trustedWebGranted)) return false;
  const delta = capabilityDelta(reviewed.manifest, current.manifest);
  return !delta.added.length && !delta.removed.length && !delta.serialScopeChanged && !delta.httpScopeChanged && !delta.trustChanged &&
    sameSet(reviewablePermissions(reviewed), reviewablePermissions(current)) &&
    sameSet(effectivePermissions(reviewed), effectivePermissions(current));
}
