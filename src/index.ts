import * as core from '@actions/core';
import * as github from '@actions/github';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_VERSION, isAllowedArchiveEntry, matchesSha256, resolveCliRelease } from './release';
import { COMMENT_MARKER, parseChangeReport, renderChangeReport, specExtension } from './report';

const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;

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

function npmCiCommand(): { command: string; args: string[] } {
  const commandText = 'npm ci --ignore-scripts --no-audit --no-fund';
  if (process.platform === 'win32') {
    return {
      command: getEnvironmentValue('ComSpec') || 'cmd.exe',
      args: ['/d', '/s', '/c', commandText]
    };
  }
  return {
    command: 'npm',
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
  };
}

async function downloadVerifiedCli(runtimeDirectory: string): Promise<string> {
  const release = resolveCliRelease(process.platform, process.arch);
  const { assetName, binaryName, expectedChecksum } = release;

  const packageDirectory = path.join(runtimeDirectory, 'node_modules', '@pb33f', 'openapi-changes');
  const archiveUrl = 'https://github.com/pb33f/openapi-changes/releases/download/v' + CLI_VERSION + '/' + assetName;
  core.info('Downloading the pinned openapi-changes ' + CLI_VERSION + ' runner binary.');
  const response = await fetch(archiveUrl, {
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'openapi-radar' }
  });
  if (!response.ok) {
    throw new Error('Could not download the pinned openapi-changes release asset: HTTP ' + response.status + '.');
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 100 * 1024 * 1024) {
    throw new Error('The openapi-changes release archive exceeds the 100 MiB safety limit.');
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength > 100 * 1024 * 1024) {
    throw new Error('The openapi-changes release archive exceeds the 100 MiB safety limit.');
  }
  if (!matchesSha256(archive, expectedChecksum)) {
    throw new Error('SHA-256 verification failed for openapi-changes release asset ' + assetName + '.');
  }

  const binaryDirectory = path.join(packageDirectory, 'bin');
  const archivePath = path.join(runtimeDirectory, assetName);
  const extractorPath = path.join(runtimeDirectory, 'extract-archive.cjs');
  await mkdir(binaryDirectory, { recursive: true });
  await writeFile(archivePath, archive, { mode: 0o600 });
  await writeFile(
    extractorPath,
    [
      "const { createRequire } = require('node:module');",
      'const runtimePackageManifest = process.argv[2];',
      'const archivePath = process.argv[3];',
      'const targetDirectory = process.argv[4];',
      'const binaryName = process.argv[5];',
      "const tar = createRequire(runtimePackageManifest)('tar');",
      'tar.x({ file: archivePath, cwd: targetDirectory, filter: (entryPath, entry) => entryPath === binaryName && entry.type === \'File\' })',
      "  .catch((error) => { console.error(error); process.exitCode = 1; });",
      ''
    ].join('\n'),
    { mode: 0o600 }
  );
  try {
    const packageManifest = path.join(packageDirectory, 'package.json');
    await runInherited(
      process.execPath,
      [extractorPath, packageManifest, archivePath, binaryDirectory, binaryName],
      runtimeDirectory,
      childEnvironment()
    );
  } finally {
    await rm(archivePath, { force: true });
    await rm(extractorPath, { force: true });
  }

  const executablePath = path.join(binaryDirectory, binaryName);
  const executable = await lstat(executablePath).catch(() => undefined);
  if (!executable?.isFile() || executable.isSymbolicLink()) {
    throw new Error('The verified release archive did not contain its expected root-level executable.');
  }
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);
  core.info('Verified openapi-changes release asset SHA-256: ' + expectedChecksum + '.');
  return executablePath;
}

async function prepareRuntime(runtimeDirectory: string): Promise<string> {
  const committedRuntimeDirectory = path.resolve(__dirname, '..', 'runtime');
  await Promise.all([
    copyFile(path.join(committedRuntimeDirectory, 'package.json'), path.join(runtimeDirectory, 'package.json')),
    copyFile(path.join(committedRuntimeDirectory, 'package-lock.json'), path.join(runtimeDirectory, 'package-lock.json'))
  ]);
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
  const install = npmCiCommand();
  core.info('Preparing the locked OpenAPI change reporter with npm lifecycle scripts disabled.');
  await runInherited(install.command, install.args, runtimeDirectory, installEnv);
  return downloadVerifiedCli(runtimeDirectory);
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
    const baseFile = path.join(runtimeDirectory, 'base' + specExtension(baseSpecPath));
    const headFile = path.join(runtimeDirectory, 'head' + specExtension(headSpecPath));
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
    const parsedReport = parseChangeReport(reportText);
    const result = renderChangeReport(parsedReport, headSpecPath, baseSha, headSha);
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
