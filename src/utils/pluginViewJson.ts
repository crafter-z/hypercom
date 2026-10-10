export interface BoundedJsonValue { value: unknown; bytes: number; }

/** Only JSON values cross the native view bridge; binary containers must use parsed models. */
export function boundedPluginViewJson(value: unknown, maximum: number): BoundedJsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 65536 || depth > 64) throw new Error('plugin view JSON complexity exceeded');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.length > maximum) throw new Error('plugin view payload capacity exceeded');
      return;
    }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('plugin view JSON numbers must be finite'); return; }
    if (typeof item !== 'object') throw new Error('plugin view accepts JSON values only');
    const object = item as object;
    const prototype = Object.getPrototypeOf(object);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error('plugin view accepts JSON values only');
    if (ancestors.has(object)) throw new Error('plugin view JSON must not contain cycles');
    ancestors.add(object);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index], depth + 1);
    } else {
      for (const key of Object.keys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('plugin view JSON must not contain getters');
        visit(key, depth + 1); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(object);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > maximum) throw new Error('plugin view payload capacity exceeded');
  return { value: JSON.parse(json), bytes };
}
