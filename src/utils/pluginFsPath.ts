/** New FS wire paths use Rust str::len (UTF-8 bytes), not UTF-16 code units.
 * Legacy whole-file/directory APIs deliberately retain their existing contract. */
export const MAX_PLUGIN_FS_PATH_BYTES = 4096;

/** Count bounded UTF-8 without allocating a copy; reject unpaired surrogates
 * because serde_json cannot deserialize those as a Rust String either. */
export function isPluginFsPath(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > MAX_PLUGIN_FS_PATH_BYTES) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > MAX_PLUGIN_FS_PATH_BYTES) return false;
  }
  return true;
}

export function requirePluginFsPath(value: string, allowEmpty = false): string {
  if (!isPluginFsPath(value, allowEmpty)) throw new Error(`参数 rel 必须为有效 Unicode 路径且不超过 ${MAX_PLUGIN_FS_PATH_BYTES} UTF-8 字节`);
  return value;
}
