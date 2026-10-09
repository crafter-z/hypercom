import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRelease, buildManifest, preflight, requiredPlatforms, verifyManifest, verifySignature, versionForTag } from './release.mjs';

const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const keyId = Buffer.from('0102030405060708', 'hex');
const pubkey = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, publicBytes]).toString('base64')}\n`).toString('base64');

function signatureFor(data, algorithm = 'ED') {
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const signature = sign(null, message, privateKey);
  const trusted = 'timestamp:1700000000\tfile:fixture';
  const packet = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64');
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey).toString('base64');
  return Buffer.from(`untrusted comment: signature from tauri secret key\n${packet}\ntrusted comment: ${trusted}\n${global}\n`).toString('base64');
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hypercom-release-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function source(t, version = '1.2.3') {
  const root = await directory(t);
  await mkdir(join(root, 'src-tauri'));
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'hypercom', version })),
    writeFile(join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } })),
    writeFile(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version, plugins: { updater: { pubkey } } })),
    writeFile(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "hypercom"\nversion = "${version}"\n\n[dependencies]\n`),
    writeFile(join(root, 'src-tauri/Cargo.lock'), `version = 4\n\n[[package]]\nname = "dependency"\nversion = "9.0.0"\n\n[[package]]\nname = "hypercom"\nversion = "${version}"\ndependencies = [\n "dependency",\n]\n`),
    writeFile(join(root, 'RELEASE_NOTES.md'), `# HyperCom v${version}\n\nCurrent notes\n\n# HyperCom v0.0.1\n\nOld notes\n`),
  ]);
  return root;
}

async function fixture(t, channel = 'stable', extras = false) {
  const path = await directory(t);
  const version = channel === 'stable' ? '1.2.3' : '1.2.3-preview.1';
  const tag = `v${version}`;
  const names = [
    `hypercom_${version}_x64-setup.exe`, `hypercom_${version}_amd64.AppImage`,
    `hypercom_${version}_aarch64.app.tar.gz`, `hypercom_${version}_x64.app.tar.gz`,
  ];
  if (channel === 'stable') names.push(`hypercom_${version}_x64_en-US.msi`);
  if (extras) names.push(`hypercom_${version}_amd64.deb`, `hypercom-${version}-1.x86_64.rpm`);
  const assets = [];
  for (const [index, name] of names.entries()) {
    const data = Buffer.from(`real signed fixture bytes: ${name}\n`);
    const signature = signatureFor(data, index % 2 ? 'Ed' : 'ED');
    await writeFile(join(path, name), data);
    await writeFile(join(path, name + '.sig'), signature);
    for (const [assetName, size] of [[name, data.length], [name + '.sig', signature.length]]) {
      assets.push({ id: assets.length + 1, name: assetName, state: 'uploaded', size, browser_download_url: `https://github.com/example/hypercom/releases/download/${tag}/${assetName}` });
    }
  }
  return { path, options: { channel, tag, repository: 'example/hypercom', pubkey, assets, notes: 'Current notes', publishedAt: '2026-01-01T00:00:00Z', readAsset: (asset) => readFile(join(path, asset.name)), binaryPath: async (asset) => join(path, asset.name) } };
}

test('strict channel tags reject mismatches and noncanonical versions', () => {
  assert.equal(versionForTag('stable', 'v1.2.3'), '1.2.3');
  assert.equal(versionForTag('preview', 'v1.2.3-preview.1'), '1.2.3-preview.1');
  for (const tag of ['1.2.3', 'v01.2.3', 'v1.2.3+build', 'v1.2.3-preview.1', 'v1.2.3-extra']) assert.throws(() => versionForTag('stable', tag), /Invalid/);
  for (const tag of ['v1.2.3', 'v1.2.3-preview', 'v1.2.3-preview.01', 'v1.2.3-preview.1-extra']) assert.throws(() => versionForTag('preview', tag), /Invalid/);
});

test('preflight binds all root versions and first notes section to the triggering tag', async (t) => {
  const root = await source(t);
  const result = await preflight(root, 'stable', 'v1.2.3');
  assert.equal(result.body, '# HyperCom v1.2.3\n\nCurrent notes');
  await assert.rejects(preflight(root, 'stable', 'v1.2.4'), /triggering tag version 1.2.4/);
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.2' } } }));
  await assert.rejects(preflight(root, 'stable', 'v1.2.3'), /packages\[""\]/);
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  await writeFile(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "hypercom"\nversion = "1.2.2"\n');
  await assert.rejects(preflight(root, 'stable', 'v1.2.3'), /Cargo.lock root/);
  await writeFile(join(root, 'RELEASE_NOTES.md'), '# HyperCom v1.2.2\n\n# HyperCom v1.2.3\n');
  await assert.rejects(preflight(root, 'stable', 'v1.2.3'), /first section: 1.2.2/);
});

test('preflight accepts preview and rejects npm, tauri and Cargo manifest drift', async (t) => {
  for (const filename of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml']) {
    const root = await source(t, '1.2.3-preview.1');
    await preflight(root, 'preview', 'v1.2.3-preview.1');
    const text = await readFile(join(root, filename), 'utf8');
    await writeFile(join(root, filename), text.replace('1.2.3-preview.1', '1.2.3-preview.2'));
    await assert.rejects(preflight(root, 'preview', 'v1.2.3-preview.1'), /preflight failed/);
  }
});

test('prepare/finalize release identity guard refuses published releases or wrong channels', () => {
  const draft = { id: 4, tag_name: 'v1.2.3', draft: true, prerelease: false };
  assertRelease(draft, 'stable', 'v1.2.3', true);
  assert.throws(() => assertRelease({ ...draft, draft: false }, 'stable', 'v1.2.3', true), /already published/);
  assert.throws(() => assertRelease({ ...draft, prerelease: true }, 'stable', 'v1.2.3', true), /refusing/);
  assert.throws(() => assertRelease({ ...draft, tag_name: 'v1.2.2' }, 'stable', 'v1.2.3', true), /refusing/);
});

test('complete stable manifest verifies actual signatures and keeps NSIS default plus installer keys', async (t) => {
  const { options } = await fixture(t, 'stable', true);
  const manifest = await buildManifest(options);
  assert.equal(manifest.version, '1.2.3');
  for (const platform of requiredPlatforms) assert.ok(manifest.platforms[platform]);
  for (const key of ['windows-x86_64-msi', 'windows-x86_64-nsis', 'linux-x86_64-appimage', 'linux-x86_64-deb', 'linux-x86_64-rpm', 'darwin-aarch64-app', 'darwin-x86_64-app']) assert.ok(manifest.platforms[key]);
  assert.match(manifest.platforms['windows-x86_64'].url, /x64-setup\.exe$/);
  assert.match(manifest.platforms['linux-x86_64'].url, /AppImage$/);
  for (const entry of Object.values(manifest.platforms)) assert.match(entry.url, /^https:\/\/github\.com\/example\/hypercom\/releases\/download\/v1\.2\.3\//);
  verifyManifest(JSON.parse(JSON.stringify(manifest)), manifest);
  const wrong = structuredClone(manifest);
  wrong.platforms['windows-x86_64'].url = 'https://api.github.com/repos/example/hypercom/releases/assets/1';
  assert.throws(() => verifyManifest(wrong, manifest), /mismatched/);
  wrong.version = '1.2.2';
  assert.throws(() => verifyManifest(wrong, manifest), /version/);
});

test('complete preview needs no MSI but all four platforms', async (t) => {
  const { options } = await fixture(t, 'preview');
  const manifest = await buildManifest(options);
  for (const platform of requiredPlatforms) assert.ok(manifest.platforms[platform]);
  assert.equal(manifest.platforms['windows-x86_64-msi'], undefined);
  assert.equal(manifest.version, '1.2.3-preview.1');
});

test('missing binaries/signatures and incomplete upload metadata produce actionable errors', async (t) => {
  const { options } = await fixture(t);
  const missing = options.assets.filter((asset) => !asset.name.includes('_aarch64.app.tar.gz'));
  await assert.rejects(buildManifest({ ...options, assets: missing }), /Missing installer asset: darwin-aarch64-app/);
  const unsigned = options.assets.filter((asset) => !asset.name.endsWith('setup.exe.sig'));
  await assert.rejects(buildManifest({ ...options, assets: unsigned }), /Missing signature:.*setup.exe.sig/);
  const partial = options.assets.map((asset, i) => i ? asset : { ...asset, state: 'new', size: 0 });
  await assert.rejects(buildManifest({ ...options, assets: partial }), /not completely uploaded/);
});

test('API URLs, cross-tag assets, old-version names and duplicate installers are rejected', async (t) => {
  const { options } = await fixture(t);
  for (const browser_download_url of ['https://api.github.com/repos/example/hypercom/releases/assets/1', options.assets[0].browser_download_url.replace('/v1.2.3/', '/v1.2.2/')]) {
    await assert.rejects(buildManifest({ ...options, assets: options.assets.map((asset, i) => i ? asset : { ...asset, browser_download_url }) }), /tag-bound/);
  }
  const old = options.assets.map((asset) => ({ ...asset, name: asset.name.replace('_1.2.3_', '_1.2.2_'), browser_download_url: asset.browser_download_url.replace('_1.2.3_', '_1.2.2_') }));
  await assert.rejects(buildManifest({ ...options, assets: old }), /Asset version mismatch/);
  await assert.rejects(buildManifest({ ...options, assets: [...options.assets, options.assets[0]] }), /Duplicate asset/);
});

test('binary tampering fails real artifact verification and prevents complete manifest', async (t) => {
  const { path, options } = await fixture(t);
  await writeFile(join(path, options.assets[0].name), 'tampered executable');
  await assert.rejects(buildManifest(options), /windows-x86_64-nsis: Minisign artifact signature verification failed/);
});

test('trusted comment, key ID, and signature tampering fail minisign verification', async (t) => {
  const path = join(await directory(t), 'binary');
  const data = Buffer.from('signed bytes');
  await writeFile(path, data);
  for (const algorithm of ['ED', 'Ed']) {
    const signature = signatureFor(data, algorithm);
    await verifySignature(path, signature, pubkey);
    const text = Buffer.from(signature, 'base64').toString();
    const modified = Buffer.from(text.replace('timestamp:1700000000', 'timestamp:1700000001')).toString('base64');
    await assert.rejects(verifySignature(path, modified, pubkey), /trusted-comment signature verification failed/);
    const lines = text.trim().split('\n');
    const packet = Buffer.from(lines[1], 'base64');
    packet[2] ^= 1;
    lines[1] = packet.toString('base64');
    await assert.rejects(verifySignature(path, Buffer.from(lines.join('\n') + '\n').toString('base64'), pubkey), /key ID mismatch/);
    packet[2] ^= 1;
    packet[10] ^= 1;
    lines[1] = packet.toString('base64');
    await assert.rejects(verifySignature(path, Buffer.from(lines.join('\n') + '\n').toString('base64'), pubkey), /artifact signature verification failed/);
  }
});

test('offline CLI smoke generates complete latest.json and rejects later binary tampering without credentials', async (t) => {
  const root = await source(t);
  const { path, options } = await fixture(t);
  const metadata = join(path, 'assets.json');
  await writeFile(metadata, JSON.stringify({ repository: options.repository, pubkey, assets: options.assets }));
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const env = { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: '' };
  const run = () => spawnSync(process.execPath, [script, 'local', 'stable', 'v1.2.3', metadata], { cwd: root, env, encoding: 'utf8' });
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  const manifest = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8'));
  for (const platform of requiredPlatforms) assert.ok(manifest.platforms[platform]);
  verifyManifest(manifest, await buildManifest(options));
  await writeFile(join(path, options.assets[0].name), 'tampered after signing');
  const tampered = run();
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /artifact signature verification failed/);
});

test('failed or cancelled matrix prevents every GitHub request and explains how to recover draft', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  for (const matrix of ['failure', 'cancelled', 'skipped']) {
    const result = spawnSync(process.execPath, [script, 'finalize', 'preview', 'v1.2.3-preview.1', '123'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: 'unused-test-token', GITHUB_REPOSITORY: 'example/hypercom', GITHUB_API_URL: 'http://127.0.0.1:1', PREPARE_RESULT: 'success', MATRIX_RESULT: matrix },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`matrix=${matrix}`));
    assert.match(result.stderr, /Inspect failed\/cancelled matrix jobs/);
    assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/);
  }
});

test('stable requires MSI in addition to NSIS; preview refuses MSI assets', async (t) => {
  const stable = await fixture(t);
  await assert.rejects(buildManifest({ ...stable.options, assets: stable.options.assets.filter((asset) => !asset.name.includes('.msi')) }), /Missing installer asset: windows-x86_64-msi/);
  const preview = await fixture(t, 'preview');
  const name = 'hypercom_1.2.3-preview.1_x64_en-US.msi';
  const data = Buffer.from('signed preview MSI that must not ship');
  const signature = signatureFor(data);
  await writeFile(join(preview.path, name), data);
  await writeFile(join(preview.path, name + '.sig'), signature);
  const assets = [...preview.options.assets];
  for (const [assetName, size] of [[name, data.length], [name + '.sig', signature.length]]) assets.push({ name: assetName, state: 'uploaded', size, browser_download_url: `https://github.com/example/hypercom/releases/download/v1.2.3-preview.1/${assetName}` });
  await assert.rejects(buildManifest({ ...preview.options, assets }), /Preview must contain NSIS only, not MSI/);
});
