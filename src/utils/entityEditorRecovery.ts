/** Best-effort crash/session-end recovery, never a persistence/runtime authority. */
import type { EntityKey } from './entityEditor';

type Fields = Record<string, 'string' | 'number' | 'boolean'>;
function entityShape(value: unknown, fields: Fields, optional: Fields = {}, nested?: { key: string; fields: Fields; optional?: Fields }): boolean {
  if (!recoveryRecord(value)) return false;
  const allowed = new Set([...Object.keys(fields), ...Object.keys(optional), ...(nested ? [nested.key] : [])]);
  if (Object.keys(value).some(key => !allowed.has(key))) return false;
  const matches = (key: string, type: string) => typeof value[key] === type && (type !== 'number' || Number.isFinite(value[key]));
  if (!Object.entries(fields).every(([key, type]) => matches(key, type))) return false;
  if (!Object.entries(optional).every(([key, type]) => value[key] === undefined || matches(key, type))) return false;
  if (nested && (!Array.isArray(value[nested.key]) || !(value[nested.key] as unknown[]).every(item => entityShape(item, nested.fields, nested.optional)))) return false;
  return true;
}

/** Shape-only validation retains incomplete text/HEX drafts, but never restores
 * foreign fields or malformed nested structures into an editor. */
export function recoverableEntityCollection(kind: EntityKey, value: unknown): value is Array<{ id: string }> {
  if (!Array.isArray(value)) return false;
  return value.every(item => {
    const common: Fields = { id: 'string', name: 'string' };
    switch (kind) {
      case 'sendCommandSets': return entityShape(item, { ...common, isLoop: 'boolean', loopDelay: 'number', repeatCount: 'number' }, {}, {
        key: 'commands', fields: { ...common, order: 'number', delay: 'number', type: 'string', content: 'string', appendLineEnding: 'string' },
      });
      case 'highlightRuleSets': return entityShape(item, { ...common, isEnabled: 'boolean' }, {}, {
        key: 'rules', fields: { ...common, pattern: 'string', isRegex: 'boolean' }, optional: { color: 'string', bold: 'boolean', italic: 'boolean' },
      });
      case 'portToolConfigs': return entityShape(item, { ...common, portId: 'string', command: 'string', workdir: 'string' });
      case 'triggerRules': return entityShape(item, { ...common, pattern: 'string', isRegex: 'boolean', matchType: 'string', actionType: 'string', actionContent: 'string', actionIsHex: 'boolean', isEnabled: 'boolean' }, { portId: 'string' });
      case 'protocolTemplates': return entityShape(item, { ...common, isEnabled: 'boolean', headerBytes: 'string', lengthFieldOffset: 'number', lengthFieldSize: 'number', lengthEndian: 'string', lengthAdjust: 'number', checksumAlgorithm: 'string', checksumOffset: 'number', footerBytes: 'string', colorHeader: 'string', colorLength: 'string', colorPayload: 'string', colorChecksum: 'string', colorFooter: 'string' });
    }
  });
}
const PREFIX = 'hypercom.editor-recovery.';
export function recoveryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function recoveryKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

export function readEditorRecovery<T>(key: string, validate: (value: unknown) => value is T): T | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const envelope: unknown = JSON.parse(raw);
    if (!recoveryRecord(envelope) || !recoveryKeys(envelope, ['schema', 'payload']) || envelope.schema !== 1 || !validate(envelope.payload)) return null;
    return envelope.payload;
  } catch {
    // Storage may be denied/full or contain a partial/old schema. Startup and
    // ordinary editing must remain usable, with the persisted config untouched.
    return null;
  }
}

export function writeEditorRecovery(key: string, payload: unknown | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (payload === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify({ schema: 1, payload }));
  } catch {
    // Best effort only. A recovery failure never fabricates a successful save.
  }
}
