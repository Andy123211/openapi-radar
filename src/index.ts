import * as core from '@actions/core';
import * as github from '@actions/github';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLI_VERSION = '0.2.11';
const COMMENT_MARKER = '<!-- openapi-radar:report -->';
const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_COMMENTED_CHANGES = 35;

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

interface RepositoryPayload {
  name?: string;
  owner?: { login?: string };
}

interface PullRequestPayload {
  number?: number;
  base?: { sha?: string; repo?: RepositoryPayload };
  head?: { sha?: string; repo?: RepositoryPayload | null };
}

interface RepositoryCoordinate {
  owner: string;
  repo: string;
}

interface ApiFile {
  type?: string;
  content?: string;
  encoding?: string;
  sha?: string;
  size?: number;
}

interface ApiBlob {
  content?: string;
  encoding?: string;
  size?: number;
}

interface TarExtractor {
  x(options: {
    file: string;
    cwd: string;
    filter: (entryPath: string) => boolean;
  }): Promise<unknown>;
}

interface ReportChange {
  breaking?: boolean;
  path?: unknown;
  type?: unknown;
  property?: unknown;
  kind?: unknown;
  original?: unknown;
  new?: unknown;
}

interface ChangeReport {
  changes?: ReportChange[];
  reportSummary?: {
    totalChanges?: unknown;
    breakingChanges?: unknown;
  };
}

interface ExistingComment {
  id: number;
  body?: string | null;
  user?: { type?: string } | null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getEnvironmentValue(...names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(process.env)) {
    if (wanted.has(name.toLowerCase()) && value) return value;
  }
  return undefined;
}

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const allowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS'
  ];
  for (const name of allowed) {
    const value = getEnvironmentValue(name);
    if (value) result[name] = value;
  }
  return { ...result, ...extra };
}

function repositoryCoordinate(repository: RepositoryPayload | null | undefined): RepositoryCoordinate {
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!owner || !repo) {
    throw new Error('The pull request payload is missing a base or head repository.');
  }
  return { owner, repo };
}

function safeSpecPath(input: string, label: string): string {
  const value = input.trim();
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(label + ' must be a repository-relative path using forward slashes.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(label + ' cannot contain empty, dot, or parent-directory segments.');
  }
  return value;
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/\s/g, ''), 'base64');
}

async function fetchSpec(
  octokit: ReturnType<typeof github.getOctokit>,
  repository: RepositoryCoordinate,
  ref: string,
  filePath: string
): Promise<Buffer> {
  const response = await octokit.rest.repos.getContent({
    owner: repository.owner,
    repo: repository.repo,
    path: filePath,
    ref
  });
  const file = response.data as unknown as ApiFile;
  if (file.type !== 'file' || !file.sha) {
    throw new Error('Expected ' + filePath + ' at ' + ref.slice(0, 7) + ' to be a regular file.');
  }
  if (typeof file.size === 'number' && file.size > MAX_SPEC_BYTES) {
    throw new Error(filePath + ' is larger than the 5 MiB OpenAPI spec limit.');
  }

  let content: Buffer;
  if (file.encoding === 'base64' && typeof file.content === 'string') {
    content = decodeBase64(file.content);
  } else {
    const blobResponse = await octokit.rest.git.getBlob({
      owner: repository.owner,
      repo: repository.repo,
      file_sha: file.sha
    });
    const blob = blobResponse.data as unknown as ApiBlob;
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new Error('GitHub did not return base64 file contents for ' + filePath + '.');
    }
    content = decodeBase64(blob.content);
  }
  if (content.byteLength > MAX_SPEC_BYTES) {
    throw new Error(filePath + ' is larger than the 5 MiB OpenAPI spec limit.');
  }
  return content;
}

async function runInherited(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(command + ' failed with exit code ' + String(code) + (signal ? ' (' + signal + ')' : '')));
      }
    });
  });
}

async function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let tooLarge = false;

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_REPORT_BYTES) {
        tooLarge = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (tooLarge) {
        reject(new Error('openapi-changes produced more than 20 MiB of report output.'));
        return;
      }
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error('openapi-changes failed' + (stderrText ? ': ' + stderrText : '') + (signal ? ' (' + signal + ')' : '')));
        return;
      }
      if (stderrText) core.warning(stderrText.slice(0, 4000));
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

function npmInstallCommand(): { command: string; args: string[] } {
  const commandText = 'npm install --ignore-scripts --no-save --no-package-lock --no-audit --no-fund @pb33f/openapi-changes@' + CLI_VERSION;
  if (process.platform === 'win32') {
    return {
      command: getEnvironmentValue('ComSpec') || 'cmd.exe',
      args: ['/d', '/s', '/c', commandText]
    };
  }
  return {
    command: 'npm',
    args: ['install', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '@pb33f/openapi-changes@' + CLI_VERSION]
  };
}

function cliAssetName(): string {
  const platforms: Record<string, string> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows'
  };
  const architectures: Record<string, string> = {
    arm64: 'arm64',
    ia32: 'i386',
    x64: 'x86_64'
  };
  const platform = platforms[process.platform];
  const architecture = architectures[process.arch];
  if (!platform || !architecture) {
    throw new Error('Unsupported runner platform: ' + process.platform + '/' + process.arch + '.');
  }
  return 'openapi-changes_' + CLI_VERSION + '_' + platform + '_' + architecture + '.tar.gz';
}

async function downloadVerifiedCli(runtimeDirectory: string): Promise<string> {
  const assetName = cliAssetName();
  const expectedChecksum = CLI_CHECKSUMS[assetName];
  if (!expectedChecksum) throw new Error('No pinned SHA-256 checksum is available for ' + assetName + '.');

  const packageDirectory = path.join(runtimeDirectory, 'node_modules', '@pb33f', 'openapi-changes');
  const packageManifest = path.join(packageDirectory, 'package.json');
  const packageRequire = createRequire(packageManifest);
  const tar = packageRequire('tar') as TarExtractor;
  const archiveUrl = 'https://github.com/pb33f/openapi-changes/releases/download/v' + CLI_VERSION + '/' + assetName;
  core.info('Downloading the pinned openapi-changes ' + CLI_VERSION + ' runner binary.');
  const response = await fetch(archiveUrl, {
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'openapi-radar' }
  });
  if (!response.ok) {
    throw new Error('Could not download the pinned openapi-changes release asset: HTTP ' + response.status + '.');
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actualChecksum = createHash('sha256').update(archive).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new Error('SHA-256 verification failed for openapi-changes release asset ' + assetName + '.');
  }

  const binaryName = process.platform === 'win32' ? 'openapi-changes.exe' : 'openapi-changes';
  const binaryDirectory = path.join(packageDirectory, 'bin');
  const archivePath = path.join(runtimeDirectory, assetName);
  await mkdir(binaryDirectory, { recursive: true });
  await writeFile(archivePath, archive, { mode: 0o600 });
  try {
    await tar.x({
      file: archivePath,
      cwd: binaryDirectory,
      filter: (entryPath) => entryPath === binaryName
    });
  } finally {
    await rm(archivePath, { force: true });
  }

  const executablePath = path.join(binaryDirectory, binaryName);
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);
  core.info('Verified openapi-changes release asset SHA-256: ' + actualChecksum + '.');
  return executablePath;
}

async function prepareRuntime(runtimeDirectory: string): Promise<string> {
  await writeFile(
    path.join(runtimeDirectory, 'package.json'),
    JSON.stringify({ name: 'openapi-radar-runtime', version: '1.0.0', private: true }) + '\n',
    { mode: 0o600 }
  );
  const userConfig = path.join(runtimeDirectory, 'npm-user.npmrc');
  const globalConfig = path.join(runtimeDirectory, 'npm-global.npmrc');
  const config = 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n';
  await writeFile(userConfig, config, { mode: 0o600 });
  await writeFile(globalConfig, config, { mode: 0o600 });
  const installEnv = childEnvironment({
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: path.join(runtimeDirectory, 'npm-cache')
  });
  const install = npmInstallCommand();
  core.info('Preparing the pinned OpenAPI change reporter with npm lifecycle scripts disabled.');
  await runInherited(install.command, install.args, runtimeDirectory, installEnv);
  return downloadVerifiedCli(runtimeDirectory);
}

function concise(value: unknown, maxLength = 180): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value === undefined || value === null) {
    text = 'unspecified';
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) text = text.slice(0, maxLength - 1) + '…';
  return text;
}

function inlineCode(value: string): string {
  const runs = value.match(new RegExp(String.fromCharCode(96) + '+', 'g')) || [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = String.fromCharCode(96).repeat(longestRun + 1);
  return fence + ' ' + value + ' ' + fence;
}

function migrationHint(change: ReportChange): string {
  const details = [change.path, change.type, change.property, change.kind]
    .map((value) => concise(value, 240))
    .join(' ')
    .toLowerCase();
  if (details.includes('required')) {
    return 'Keep the field optional or update every affected client to send it before merging.';
  }
  if (details.includes('path') && (details.includes('removed') || details.includes('deleted'))) {
    return 'Keep the existing endpoint during migration, or provide a versioned replacement and a deprecation window.';
  }
  if (details.includes('response')) {
    return 'Preserve the previous response shape or status, or update and release affected clients before removing it.';
  }
  if (details.includes('type') || details.includes('schema')) {
    return 'Keep a compatible schema during transition, or regenerate and release every client that depends on this type.';
  }
  if (details.includes('removed') || details.includes('delete')) {
    return 'Restore the removed element or migrate its consumers before merging the contract change.';
  }
  return 'Update affected clients to handle this contract change, or keep a compatibility path until they have migrated.';
}

function numericCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function makeReportMarkdown(
  report: ChangeReport,
  specPath: string,
  baseSha: string,
  headSha: string
): { markdown: string; totalChanges: number; breakingChanges: ReportChange[]; breakingCount: number } {
  const changes = Array.isArray(report.changes) ? report.changes : [];
  const breakingChanges = changes.filter((change) => change.breaking === true);
  const totalChanges = numericCount(report.reportSummary?.totalChanges) ?? changes.length;
  const breakingCount = numericCount(report.reportSummary?.breakingChanges) ?? breakingChanges.length;

  let markdown = COMMENT_MARKER;
  markdown += '\n## OpenAPI compatibility report\n\n';
  markdown += '**Spec:** ' + inlineCode(concise(specPath, 240)) + '  \n';
  markdown += '**Compared:** ' + inlineCode(baseSha.slice(0, 7)) + ' → ' + inlineCode(headSha.slice(0, 7)) + '  \n';
  markdown += '**Changes:** ' + String(totalChanges) + ' total, ' + String(breakingCount) + ' breaking\n\n';

  if (breakingCount === 0) {
    markdown += '✅ No breaking changes were reported.';
    if (totalChanges > 0) markdown += ' The detected changes appear backward-compatible.';
  } else {
    markdown += '### Breaking changes\n\n';
    const shown = breakingChanges.slice(0, MAX_COMMENTED_CHANGES);
    shown.forEach((change, index) => {
      const label = concise(change.path || change.type || 'OpenAPI element', 240);
      const kind = [change.type, change.kind, change.property]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => inlineCode(concise(value, 100)))
        .join(' · ');
      markdown += String(index + 1) + '. ' + inlineCode(label);
      if (kind) markdown += ' — ' + kind.replace(/[\r\n]/g, ' ');
      if (change.original !== undefined || change.new !== undefined) {
        markdown += ' (' + inlineCode(concise(change.original)) + ' → ' + inlineCode(concise(change.new)) + ')';
      }
      markdown += '\n   - Migration: ' + migrationHint(change) + '\n';
    });
    if (breakingCount > shown.length) {
      markdown += '\n_' + String(breakingCount - shown.length) + ' additional breaking changes are omitted from this concise report._\n';
    }
  }
  markdown += '\n\nGenerated by OpenAPI Radar with openapi-changes ' + CLI_VERSION + '.';
  return { markdown, totalChanges, breakingChanges, breakingCount };
}

async function updatePullRequestComment(
  octokit: ReturnType<typeof github.getOctokit>,
  repository: RepositoryCoordinate,
  pullNumber: number,
  body: string
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: repository.owner,
    repo: repository.repo,
    issue_number: pullNumber,
    per_page: 100
  });
  const existing = (comments as unknown as ExistingComment[]).find(
    (comment: ExistingComment) => comment.user?.type === 'Bot' && comment.body?.includes(COMMENT_MARKER)
  );
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: repository.owner,
      repo: repository.repo,
      comment_id: existing.id,
      body
    });
    core.info('Updated the existing OpenAPI Radar pull request comment.');
  } else {
    await octokit.rest.issues.createComment({
      owner: repository.owner,
      repo: repository.repo,
      issue_number: pullNumber,
      body
    });
    core.info('Posted an OpenAPI Radar pull request comment.');
  }
}

async function run(): Promise<void> {
  let runtimeDirectory: string | undefined;
  try {
    if (github.context.eventName !== 'pull_request') {
      throw new Error('OpenAPI Radar must run from a pull_request workflow event.');
    }
    const pullRequest = github.context.payload.pull_request as PullRequestPayload | undefined;
    const pullNumber = pullRequest?.number;
    const baseSha = pullRequest?.base?.sha;
    const headSha = pullRequest?.head?.sha;
    if (!pullNumber || !baseSha || !headSha) {
      throw new Error('The pull_request event payload is missing its number or base/head commit SHA.');
    }
    const baseRepository = repositoryCoordinate(pullRequest.base?.repo);
    const headRepository = repositoryCoordinate(pullRequest.head?.repo);
    const baseSpecPath = safeSpecPath(core.getInput('base-spec-file') || 'openapi.yaml', 'base-spec-file');
    const headSpecPath = safeSpecPath(core.getInput('head-spec-file') || 'openapi.yaml', 'head-spec-file');
    const token = core.getInput('token', { required: true });
    const octokit = github.getOctokit(token);

    core.info('Reading the OpenAPI documents from the exact base and head pull request commits.');
    const [baseSpec, headSpec] = await Promise.all([
      fetchSpec(octokit, baseRepository, baseSha, baseSpecPath),
      fetchSpec(octokit, headRepository, headSha, headSpecPath)
    ]);
    runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'openapi-radar-'));
    const extension = path.extname(headSpecPath) || path.extname(baseSpecPath) || '.yaml';
    const baseFile = path.join(runtimeDirectory, 'base' + extension);
    const headFile = path.join(runtimeDirectory, 'head' + extension);
    await Promise.all([
      writeFile(baseFile, baseSpec, { mode: 0o600 }),
      writeFile(headFile, headSpec, { mode: 0o600 })
    ]);

    const executable = await prepareRuntime(runtimeDirectory);
    core.info('Comparing the two OpenAPI documents.');
    const reportText = await runCaptured(
      executable,
      ['report', '--reproducible', baseFile, headFile],
      runtimeDirectory,
      childEnvironment()
    );
    let report: ChangeReport;
    try {
      report = JSON.parse(reportText) as ChangeReport;
    } catch {
      throw new Error('openapi-changes returned invalid JSON; check the runner log for parser diagnostics.');
    }
    const result = makeReportMarkdown(report, headSpecPath, baseSha, headSha);
    await core.summary.addRaw(result.markdown + '\n').write();
    core.setOutput('total-changes', String(result.totalChanges));
    core.setOutput('breaking-changes', String(result.breakingCount));

    if (core.getBooleanInput('update-comment')) {
      try {
        await updatePullRequestComment(octokit, baseRepository, pullNumber, result.markdown);
      } catch (error) {
        core.warning(
          'Could not write the pull request comment (' + getErrorMessage(error) +
          '). Fork pull requests commonly receive a read-only GITHUB_TOKEN; the report summary is in the job summary.'
        );
      }
    }

    if (result.breakingCount > 0 && core.getBooleanInput('fail-on-breaking')) {
      core.setFailed('Found ' + String(result.breakingCount) + ' breaking OpenAPI change(s).');
    } else {
      core.info('OpenAPI compatibility report completed: ' + String(result.breakingCount) + ' breaking change(s).');
    }
  } catch (error) {
    core.setFailed(getErrorMessage(error));
  } finally {
    if (runtimeDirectory) {
      await rm(runtimeDirectory, { recursive: true, force: true }).catch((error: unknown) => {
        core.warning('Could not remove the temporary OpenAPI Radar files: ' + getErrorMessage(error));
      });
    }
  }
}

void run();
