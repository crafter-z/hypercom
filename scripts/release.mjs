import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const integer = '(?:0|[1-9][0-9]*)';
const core = `${integer}\\.${integer}\\.${integer}`;
export const requiredPlatforms = ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64'];

export function versionForTag(channel, tag) {
  const pattern = channel === 'stable' ? `^v${core}$` : channel === 'preview' ? `^v${core}-preview\\.${integer}$` : null;
  if (!pattern || !new RegExp(pattern).test(tag)) throw new Error(`Invalid ${channel} tag: ${tag}; expected ${channel === 'stable' ? 'vX.Y.Z' : 'vX.Y.Z-preview.N'} (no leading zeroes)`);
  return tag.slice(1);
}

function tomlValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]+)"\\s*(?:#.*)?$`, 'm'));
  if (!match) throw new Error(`Missing literal TOML ${key}`);
  return match[1];
}

export async function preflight(root, channel, tag) {
  const version = versionForTag(channel, tag);
  const json = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
  const [npm, config, lock, cargo, cargoLock, notes] = await Promise.all([
    json('package.json'), json('src-tauri/tauri.conf.json'), json('package-lock.json'),
    readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8'), readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8'),
    readFile(join(root, 'RELEASE_NOTES.md'), 'utf8'),
  ]);
  const packageSection = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
  const name = tomlValue(packageSection, 'name');
  const roots = cargoLock.split(/^\[\[package\]\]\s*$/m).slice(1).filter((section) => tomlValue(section, 'name') === name);
  if (roots.length !== 1) throw new Error(`Cargo.lock must contain exactly one root package ${name}`);
  const versions = {
    'package.json': npm.version, 'tauri.conf.json': config.version, 'Cargo.toml': tomlValue(packageSection, 'version'),
    'package-lock.json': lock.version, 'package-lock.json packages[""]': lock.packages?.['']?.version,
    'Cargo.lock root': tomlValue(roots[0], 'version'),
  };
  const errors = Object.entries(versions).filter(([, value]) => value !== version).map(([path, value]) => `${path}: ${value} != triggering tag version ${version}`);
  const heading = notes.match(/^# HyperCom v([^\r\n]+)\s*$/m);
  if (!heading || heading[1].trim() !== version) errors.push(`RELEASE_NOTES first section: ${heading?.[1]?.trim() ?? 'missing'} != ${version}`);
  if (errors.length) throw new Error(`Release preflight failed before mutation:\n${errors.join('\n')}`);
  const body = notes.slice(heading.index).split(/\n(?=# HyperCom v)/)[0].trim();
  return { version, tag, channel, body, pubkey: config.plugins?.updater?.pubkey };
}

function decode64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error(`${label}: invalid base64`);
  const result = Buffer.from(value.trim(), 'base64');
  if (result.toString('base64') !== value.trim()) throw new Error(`${label}: noncanonical base64`);
  return result;
}

// Tauri wraps the entire minisign public-key/signature text in base64. Verify
// both the artifact signature and the trusted-comment signature, including ED
// (BLAKE2b-512 prehashed) and legacy Ed signatures accepted by the updater.
export async function verifySignature(path, encodedSignature, encodedPubkey) {
  const keyLines = decode64(encodedPubkey, 'updater public key').toString('utf8').trim().split(/\r?\n/);
  const key = decode64(keyLines[1], 'minisign public key');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed') throw new Error('Unsupported minisign public key');
  const lines = decode64(encodedSignature, 'updater signature').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) throw new Error('Malformed minisign signature text');
  const signature = decode64(lines[1], 'minisign signature');
  const globalSignature = decode64(lines[3], 'minisign trusted-comment signature');
  const algorithm = signature.subarray(0, 2).toString();
  if (signature.length !== 74 || globalSignature.length !== 64 || !['Ed', 'ED'].includes(algorithm)) throw new Error('Unsupported minisign signature');
  if (!signature.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error('Minisign key ID mismatch');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  let message;
  if (algorithm === 'ED') {
    const hash = createHash('blake2b512');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    message = hash.digest();
  } else {
    message = await readFile(path);
  }
  if (!verify(null, message, publicKey, signature.subarray(10))) throw new Error('Minisign artifact signature verification failed');
  const trusted = Buffer.from(lines[2].slice('trusted comment: '.length));
  if (!verify(null, Buffer.concat([signature.subarray(10), trusted]), publicKey, globalSignature)) throw new Error('Minisign trusted-comment signature verification failed');
}

export function assertRelease(release, channel, tag, draft) {
  versionForTag(channel, tag);
  if (release.tag_name !== tag || release.prerelease !== (channel === 'preview') || release.draft !== draft) {
    throw new Error(`Release ${release.id}: expected tag=${tag}, prerelease=${channel === 'preview'}, draft=${draft}; refusing mutation/verification of a different or already published release`);
  }
}

function assetKind(name) {
  if (/_x64-setup\.exe$/.test(name)) return ['windows-x86_64', 'nsis'];
  if (/_x64[^/]*\.msi$/.test(name)) return ['windows-x86_64', 'msi'];
  if (/_(?:amd64|x86_64)\.AppImage$/.test(name)) return ['linux-x86_64', 'appimage'];
  if (/_(?:amd64|x86_64)\.deb$/.test(name)) return ['linux-x86_64', 'deb'];
  if (/-[^/]+\.x86_64\.rpm$/.test(name)) return ['linux-x86_64', 'rpm'];
  if (/_aarch64\.app\.tar\.gz$/.test(name)) return ['darwin-aarch64', 'app'];
  if (/_x64\.app\.tar\.gz$/.test(name) || /_x86_64\.app\.tar\.gz$/.test(name)) return ['darwin-x86_64', 'app'];
  return null;
}

export async function buildManifest({ channel, tag, repository, server = 'https://github.com', assets, pubkey, notes = '', readAsset, binaryPath, publishedAt }) {
  const version = versionForTag(channel, tag);
  const errors = [];
  const byName = new Map();
  const prefix = `${server.replace(/\/$/, '')}/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  for (const asset of assets) {
    if (byName.has(asset.name)) errors.push(`Duplicate asset: ${asset.name}`);
    byName.set(asset.name, asset);
    if (asset.browser_download_url !== prefix + encodeURIComponent(asset.name)) errors.push(`Asset URL must be tag-bound browser_download_url: ${asset.name}`);
    if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0) errors.push(`Asset not completely uploaded: ${asset.name}`);
    if (asset.name !== 'latest.json' && !asset.name.includes(`_${version}_`) && !asset.name.includes(`-${version}-`)) errors.push(`Asset version mismatch: ${asset.name}; expected ${version}`);
    if (asset.name.endsWith('.sig') && !assets.some((binary) => binary.name === asset.name.slice(0, -4))) errors.push(`Orphan signature without binary: ${asset.name}`);
  }
  const selected = new Map();
  for (const asset of assets) {
    const kind = assetKind(asset.name);
    if (!kind) continue;
    const [platform, installer] = kind;
    const key = `${platform}-${installer}`;
    if (selected.has(key)) errors.push(`Ambiguous installer assets for ${key}`);
    selected.set(key, { asset, platform, installer, signatureAsset: byName.get(`${asset.name}.sig`) });
    if (!byName.has(`${asset.name}.sig`)) errors.push(`Missing signature: ${asset.name}.sig`);
    if (channel === 'preview' && installer === 'msi') errors.push('Preview must contain NSIS only, not MSI');
  }
  const required = ['windows-x86_64-nsis', 'linux-x86_64-appimage', 'darwin-aarch64-app', 'darwin-x86_64-app'];
  if (channel === 'stable') required.push('windows-x86_64-msi');
  for (const key of required) if (!selected.has(key)) errors.push(`Missing installer asset: ${key}`);
  if (errors.length) throw new Error(`Incomplete release ${tag}:\n${errors.join('\n')}`);
  const platforms = {};
  for (const [key, { asset, platform, installer, signatureAsset }] of selected) {
    try {
      const signature = (await readAsset(signatureAsset)).toString('utf8').trim();
      await verifySignature(await binaryPath(asset), signature, pubkey);
      const entry = { signature, url: asset.browser_download_url };
      platforms[key] = entry;
      if (['nsis', 'appimage', 'app'].includes(installer)) platforms[platform] = entry;
    } catch (error) { errors.push(`${key}: ${error.message}`); }
  }
  if (errors.length) throw new Error(`Release signature gate failed:\n${errors.join('\n')}`);
  return { version, notes, pub_date: publishedAt ?? new Date().toISOString(), platforms };
}

export function verifyManifest(actual, expected) {
  const errors = [];
  if (actual.version !== expected.version) errors.push(`manifest version ${actual.version} != ${expected.version}`);
  for (const key of Object.keys(expected.platforms)) {
    if (actual.platforms?.[key]?.url !== expected.platforms[key].url || actual.platforms?.[key]?.signature !== expected.platforms[key].signature) errors.push(`Manifest missing/mismatched verified installer: ${key}`);
  }
  for (const key of Object.keys(actual.platforms ?? {})) if (!expected.platforms[key]) errors.push(`Unexpected manifest platform: ${key}`);
  if (errors.length) throw new Error(`latest.json verification failed:\n${errors.join('\n')}`);
}

function githubClient() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and contents:write/read GITHUB_TOKEN required');
  const base = `${api}/repos/${repository}`;
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...options.headers } });
    if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`);
    return response;
  }
  const json = async (path, options) => (await request(base + path, options)).json();
  async function pages(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const values = await json(`${path}?per_page=100&page=${page}`);
      all.push(...values);
      if (values.length < 100) return all;
    }
  }
  return { repository, base, request, json, pages };
}

async function output(key, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function remoteManifest(client, release, channel, tag, pubkey, directory) {
  const assets = await client.pages(`/releases/${release.id}/assets`);
  const paths = new Map();
  async function download(asset) {
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.url !== `${client.base}/releases/assets/${asset.id}`) throw new Error(`Invalid authenticated asset API URL: ${asset.name}`);
    if (!paths.has(asset.id)) {
      const path = join(directory, String(asset.id));
      const response = await client.request(asset.url, { headers: { Accept: 'application/octet-stream' } });
      await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
      if ((await stat(path)).size !== asset.size) throw new Error(`Incomplete asset download: ${asset.name}`);
      paths.set(asset.id, path);
    }
    return paths.get(asset.id);
  }
  const readAsset = async (asset) => readFile(await download(asset));
  const manifest = await buildManifest({ channel, tag, repository: client.repository, server: process.env.GITHUB_SERVER_URL, assets, pubkey, notes: release.body ?? '', publishedAt: release.published_at ?? undefined, readAsset, binaryPath: download });
  return { manifest, assets, readAsset };
}

async function main() {
  const [command, channel, tag, argument] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'preflight') {
    const result = await preflight(root, channel, tag);
    console.log(`Preflight OK: ${result.tag}`);
    return;
  }
  if (command === 'local') {
    // Offline smoke: metadata JSON contains real GitHub-shaped assets, each
    // binary and base64 Tauri .sig exists under the metadata file's directory.
    const info = await preflight(root, channel, tag);
    const fixture = JSON.parse(await readFile(argument, 'utf8'));
    const directory = dirname(resolve(argument));
    const manifest = await buildManifest({ ...info, notes: info.body, repository: fixture.repository, assets: fixture.assets, pubkey: fixture.pubkey ?? info.pubkey, readAsset: (asset) => readFile(join(directory, asset.name)), binaryPath: async (asset) => join(directory, asset.name) });
    await writeFile('latest.json', JSON.stringify(manifest, null, 2) + '\n');
    console.log('Offline signature gate OK; generated latest.json (no GitHub calls)');
    return;
  }
  const client = githubClient();
  if (command === 'prepare') {
    const info = await preflight(root, channel, tag); // No mutation precedes this.
    const matches = (await client.pages('/releases')).filter((release) => release.tag_name === tag);
    if (matches.length > 1) throw new Error(`Multiple releases for ${tag}; resolve manually`);
    let release = matches[0];
    if (release) assertRelease(release, channel, tag, true);
    const payload = { tag_name: tag, target_commitish: process.env.GITHUB_SHA, name: `HyperCom ${tag}${channel === 'preview' ? ' (preview)' : ''}`, body: info.body, draft: true, prerelease: channel === 'preview' };
    release = await client.json(release ? `/releases/${release.id}` : '/releases', { method: release ? 'PATCH' : 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
    // Invalidate the old gate on a draft rerun before new matrix uploads.
    for (const asset of await client.pages(`/releases/${release.id}/assets`)) if (asset.name === 'latest.json') await client.request(`${client.base}/releases/assets/${asset.id}`, { method: 'DELETE' });
    await output('releaseId', release.id);
    await output('tag', tag);
    console.log(`Prepared draft ${release.html_url}; never publish until finalize succeeds`);
    return;
  }
  if (!['finalize', 'verify'].includes(command)) throw new Error('Usage: node scripts/release.mjs preflight|prepare|finalize|verify|local stable|preview vVERSION [releaseId|metadata.json]');
  const statuses = { prepare: process.env.PREPARE_RESULT, matrix: process.env.MATRIX_RESULT };
  if (command === 'finalize' && (statuses.prepare !== 'success' || statuses.matrix !== 'success')) {
    throw new Error(`Release remains draft; cannot finalize: prepare=${statuses.prepare}, matrix=${statuses.matrix}. Inspect failed/cancelled matrix jobs, rerun the failed jobs or the tag workflow; all four platforms (and stable MSI) must succeed before publishing.`);
  }
  const release = command === 'finalize'
    ? await client.json(`/releases/${argument}`)
    : await client.json(`/releases/tags/${encodeURIComponent(tag)}`);
  assertRelease(release, channel, tag, command === 'finalize');
  const info = command === 'finalize' ? await preflight(root, channel, tag) : { pubkey: JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).plugins.updater.pubkey };
  const directory = await mkdtemp(join(tmpdir(), 'hypercom-release-'));
  try {
    const { manifest, assets, readAsset } = await remoteManifest(client, release, channel, tag, info.pubkey, directory);
    if (command === 'verify') {
      const asset = assets.find((item) => item.name === 'latest.json');
      if (!asset) throw new Error(`Missing latest.json on ${tag}`);
      verifyManifest(JSON.parse((await readAsset(asset)).toString('utf8')), manifest);
      console.log(`Published release ${tag}: all installer signatures and manifest entries verified`);
      return;
    }
    // Verify the serialization before the single upload. No matrix writes this asset.
    const data = JSON.stringify(manifest, null, 2) + '\n';
    verifyManifest(JSON.parse(data), manifest);
    assertRelease(await client.json(`/releases/${release.id}`), channel, tag, true);
    for (const asset of assets) if (asset.name === 'latest.json') await client.request(`${client.base}/releases/assets/${asset.id}`, { method: 'DELETE' });
    const upload = new URL(release.upload_url.split('{')[0]);
    if (upload.protocol !== 'https:' || upload.hostname !== new URL(process.env.GITHUB_API_URL ?? 'https://api.github.com').hostname.replace(/^api\./, 'uploads.') || upload.pathname !== `/repos/${client.repository}/releases/${release.id}/assets`) throw new Error('Unexpected GitHub upload URL');
    upload.searchParams.set('name', 'latest.json');
    const uploaded = await (await client.request(upload, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data })).json();
    if (uploaded.name !== 'latest.json' || uploaded.state !== 'uploaded' || uploaded.size !== Buffer.byteLength(data)) throw new Error('latest.json upload incomplete; release must remain draft');
    verifyManifest(JSON.parse((await readAsset(uploaded)).toString('utf8')), manifest);
    if (channel === 'preview') {
      assertRelease(await client.json(`/releases/${release.id}`), channel, tag, true);
      await client.json(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, prerelease: true, make_latest: 'false' }) });
    }
    console.log(channel === 'stable' ? `Verified ${tag}; draft ready for manual Publish` : `Verified ${tag}; preview published with complete manifest`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`::error::${error.message.replace(/\r?\n/g, '%0A')}%0ARelease gate failed: leave the release draft; repair the named assets/jobs and rerun before Publish.`);
    process.exitCode = 1;
  });
}
