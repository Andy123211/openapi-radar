const assert = require('node:assert/strict');
const test = require('node:test');
const runtimeManifest = require('../runtime/package.json');
const runtimeLock = require('../runtime/package-lock.json');
const {
  CLI_VERSION,
  isAllowedArchiveEntry,
  matchesSha256,
  resolveCliRelease
} = require('../.test-build/src/release.js');

test('keeps the runtime wrapper manifest and lock aligned with the pinned CLI release', () => {
  assert.equal(runtimeManifest.dependencies['@pb33f/openapi-changes'], CLI_VERSION);
  assert.equal(runtimeLock.packages['node_modules/@pb33f/openapi-changes'].version, CLI_VERSION);
});

test('resolves only the pinned platform and architecture release assets', () => {
  const assets = [
    ['darwin', 'arm64', 'openapi-changes_0.2.11_darwin_arm64.tar.gz', 'openapi-changes'],
    ['darwin', 'x64', 'openapi-changes_0.2.11_darwin_x86_64.tar.gz', 'openapi-changes'],
    ['linux', 'arm64', 'openapi-changes_0.2.11_linux_arm64.tar.gz', 'openapi-changes'],
    ['linux', 'ia32', 'openapi-changes_0.2.11_linux_i386.tar.gz', 'openapi-changes'],
    ['linux', 'x64', 'openapi-changes_0.2.11_linux_x86_64.tar.gz', 'openapi-changes'],
    ['win32', 'arm64', 'openapi-changes_0.2.11_windows_arm64.tar.gz', 'openapi-changes.exe'],
    ['win32', 'ia32', 'openapi-changes_0.2.11_windows_i386.tar.gz', 'openapi-changes.exe'],
    ['win32', 'x64', 'openapi-changes_0.2.11_windows_x86_64.tar.gz', 'openapi-changes.exe']
  ];
  for (const [platform, architecture, assetName, binaryName] of assets) {
    const release = resolveCliRelease(platform, architecture);
    assert.equal(release.assetName, assetName);
    assert.equal(release.binaryName, binaryName);
    assert.match(release.expectedChecksum, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => resolveCliRelease('freebsd', 'x64'), /Unsupported runner platform/);
  assert.throws(() => resolveCliRelease('linux', 'mips'), /Unsupported runner platform/);
});

test('restricts extraction to one root-level executable and verifies archive digests', () => {
  assert.equal(isAllowedArchiveEntry('openapi-changes', 'openapi-changes'), true);
  assert.equal(isAllowedArchiveEntry('../openapi-changes', 'openapi-changes'), false);
  assert.equal(isAllowedArchiveEntry('bin/openapi-changes', 'openapi-changes'), false);
  assert.equal(isAllowedArchiveEntry('README.md', 'openapi-changes'), false);

  const archiveBytes = Buffer.from('pinned archive fixture');
  const expected = require('node:crypto').createHash('sha256').update(archiveBytes).digest('hex');
  assert.equal(matchesSha256(archiveBytes, expected), true);
  assert.equal(matchesSha256(archiveBytes, '0'.repeat(64)), false);
});
