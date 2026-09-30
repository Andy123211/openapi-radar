import { createHash } from 'node:crypto';

export const CLI_VERSION = '0.2.11';

const CLI_CHECKSUMS: Record<string, string> = {
  'openapi-changes_0.2.11_darwin_arm64.tar.gz': '5af043778e449397e81e7f84dff7330a926f5472aeda70cbb5ab8dfaaff6b9c1',
  'openapi-changes_0.2.11_darwin_x86_64.tar.gz': 'a3e1568e9b02d7e64486b85131b3e89dc09085077fa61f9d261991d7397c3181',
  'openapi-changes_0.2.11_linux_arm64.tar.gz': '7d1bea2f3d486c1a9eed065969593c646bfe642cb4a7281936b5a9ad797bfefa',
  'openapi-changes_0.2.11_linux_i386.tar.gz': '92ab5e4e8c86d79fa4e024f7ab2167485d8c498df09b68910cbdce500203011d',
  'openapi-changes_0.2.11_linux_x86_64.tar.gz': 'c0b0b6ec61b073b9fc86500d306947ea9f7bfa84de73f6060453b259dcfd72a7',
  'openapi-changes_0.2.11_windows_arm64.tar.gz': '8e17ba3645c6d0ebfc72f243d19c3efd5b76a14d0c293ba3d7502003d8e9e333',
  'openapi-changes_0.2.11_windows_i386.tar.gz': '10a2b3ff72eddb8c042a41447e070a278346f2db7e962af32b842c6a43abd617',
  'openapi-changes_0.2.11_windows_x86_64.tar.gz': '53bf9fec9569fd7af0e4f67d3114fe099cde9028580f1121e1d31ff46e944b6a'
};

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows'
};

const ARCHITECTURE_NAMES: Record<string, string> = {
  arm64: 'arm64',
  ia32: 'i386',
  x64: 'x86_64'
};

export interface CliRelease {
  assetName: string;
  binaryName: string;
  expectedChecksum: string;
}

/** Resolve only release assets whose platform and digest are explicitly pinned. */
export function resolveCliRelease(platform: string, architecture: string): CliRelease {
  const platformName = PLATFORM_NAMES[platform];
  const architectureName = ARCHITECTURE_NAMES[architecture];
  if (!platformName || !architectureName) {
    throw new Error('Unsupported runner platform: ' + platform + '/' + architecture + '.');
  }

  const assetName = 'openapi-changes_' + CLI_VERSION + '_' + platformName + '_' + architectureName + '.tar.gz';
  const expectedChecksum = CLI_CHECKSUMS[assetName];
  if (!expectedChecksum) throw new Error('No pinned SHA-256 checksum is available for ' + assetName + '.');
  const binaryName = platform === 'win32' ? 'openapi-changes.exe' : 'openapi-changes';
  return { assetName, binaryName, expectedChecksum };
}

/** Reject every archive member except the single expected root-level executable. */
export function isAllowedArchiveEntry(entryPath: string, binaryName: string): boolean {
  return entryPath === binaryName;
}

/** Check archive bytes before extraction. */
export function matchesSha256(archive: Buffer, expectedChecksum: string): boolean {
  const actual = createHash('sha256').update(archive).digest('hex');
  return actual === expectedChecksum;
}
