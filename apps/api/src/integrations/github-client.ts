import { execFile } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { promisify } from 'node:util';
import { DomainError, redactText } from '@memvora/core';

const execute = promisify(execFile);
const ghExecutable = process.env['MEMVORA_GH_EXECUTABLE'] ?? 'gh';
export type GitHubUser = { id: number; login: string; avatarUrl: string };
export type GitHubRepository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  url: string;
};
export type GitHubContext = {
  provider: 'github';
  fullName: string;
  defaultBranch: string;
  commitSha: string;
  importedAt: string;
  files: Array<{ path: string; sha: string; size: number; text: string }>;
  issues: Array<{ number: number; title: string; state: string; url: string }>;
  pullRequests: Array<{ number: number; title: string; state: string; url: string }>;
};

export class GitHubUnavailable extends Error {
  constructor(
    message = 'GitHub CLI is unavailable or not signed in. Run gh auth login locally.',
    readonly status?: number,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GitHubUnavailable('GitHub returned an unexpected response.');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string')
    throw new GitHubUnavailable('GitHub returned an invalid text field.');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new GitHubUnavailable('GitHub returned an invalid numeric field.');
  return value;
}

/** Uses the existing local keyring login. Never exports or stores its credential. */
export async function githubRequest(path: string, timeoutMs = 20_000): Promise<unknown> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://'))
    throw new Error('Only GitHub API resource paths are supported.');
  try {
    const { stdout } = await execute(
      ghExecutable,
      ['api', '--method', 'GET', path, '-H', 'Accept: application/vnd.github+json'],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
    );
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof error.stderr === 'string'
        ? Number(/HTTP (\d{3})/.exec(error.stderr)?.[1]) || undefined
        : undefined;
    throw new GitHubUnavailable(
      'GitHub request failed. Check gh auth status, repository access, and network connectivity.',
      status,
    );
  }
}

export async function githubUser(): Promise<GitHubUser> {
  const value = record(await githubRequest('/user'));
  return {
    id: number(value['id']),
    login: string(value['login']),
    avatarUrl: string(value['avatar_url']),
  };
}

function repository(value: unknown): GitHubRepository {
  const item = record(value);
  return {
    id: number(item['id']),
    fullName: string(item['full_name']),
    name: string(item['name']),
    private: item['private'] === true,
    description: typeof item['description'] === 'string' ? item['description'] : null,
    defaultBranch: string(item['default_branch']),
    url: string(item['html_url']),
  };
}

export async function githubRepositories(
  page = 1,
): Promise<{ items: GitHubRepository[]; page: number; hasMore: boolean }> {
  const value = await githubRequest(
    `/user/repos?per_page=30&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
  );
  if (!Array.isArray(value))
    throw new GitHubUnavailable('GitHub did not return a repository list.');
  return { items: value.map(repository), page, hasMore: value.length === 30 };
}

export function validateFullName(value: string): boolean {
  return (
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value) &&
    value.length <= 220 &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

const excluded =
  /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|\.memvora|\.venv|__pycache__|secrets?)(\/|$)|(^|\/)\.env(?:\.|$)|\.(pem|key|p12|pfx|lock|sqlite|db)(?:$|\.)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const supported = /\.(ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|sql|md|yaml|yml|toml|css|html)$/i;

/** Defense in depth before any repository text is persisted. */
export function redactRepositoryText(text: string): string {
  return redactText(text);
}

export async function importGitHubContext(
  fullName: string,
  request: typeof githubRequest = githubRequest,
  verifiedInstallationRepositoryId?: number,
): Promise<{ repository: GitHubRepository; context: GitHubContext; partial: boolean }> {
  if (!validateFullName(fullName)) throw new Error('Use a repository name in owner/name form.');
  const deadline = Date.now() + 45_000;
  const read = (path: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new GitHubUnavailable('The bounded GitHub import reached its time limit.');
    return request(path, Math.min(20_000, remaining));
  };
  const raw = record(await read(`/repos/${fullName}`));
  const repo = repository(raw);
  // App callers must first verify user/installation membership. Fine-grained metadata can omit permissions.
  if (verifiedInstallationRepositoryId !== undefined) {
    if (
      !Number.isSafeInteger(verifiedInstallationRepositoryId) ||
      repo.id !== verifiedInstallationRepositoryId
    )
      throw new DomainError(
        'GITHUB_ACCESS_DENIED',
        'GitHub returned a different repository identity.',
        403,
      );
  } else if (record(raw['permissions'])['pull'] !== true) {
    throw new GitHubUnavailable('The current GitHub identity cannot read this repository.');
  }
  const context: GitHubContext = {
    provider: 'github',
    fullName,
    defaultBranch: repo.defaultBranch,
    commitSha: '',
    importedAt: new Date().toISOString(),
    files: [],
    issues: [],
    pullRequests: [],
  };
  // A failed fetch is not an empty repository; GitHub reports genuinely empty history as 409.
  let commit: Record<string, unknown>;
  try {
    commit = record(
      await read(`/repos/${fullName}/commits/${encodeURIComponent(repo.defaultBranch)}`),
    );
  } catch (error) {
    if (
      (error instanceof GitHubUnavailable && error.status === 409) ||
      (error instanceof DomainError && error.code === 'GITHUB_REPOSITORY_EMPTY')
    )
      return { repository: repo, context, partial: false };
    throw error;
  }
  context.commitSha = string(commit['sha']);
  const treeSha = string(record(record(commit['commit'])['tree'])['sha']);
  const tree = record(await read(`/repos/${fullName}/git/trees/${treeSha}?recursive=1`));
  const entries = tree['tree'];
  if (!Array.isArray(entries))
    throw new GitHubUnavailable('GitHub did not return a repository tree.');
  const eligible = entries
    .map(record)
    .filter(
      (item) =>
        item['type'] === 'blob' &&
        item['mode'] !== '120000' &&
        typeof item['path'] === 'string' &&
        supported.test(item['path']) &&
        !excluded.test(item['path']),
    );
  const candidates = eligible.filter(
    (item) => typeof item['size'] === 'number' && item['size'] <= 24_576,
  );
  candidates.sort((a, b) => {
    const score = (entry: Record<string, unknown>) =>
      /(^|\/)(package\.json|.*config\.[^/]+)$/.test(String(entry['path']))
        ? 0
        : /\.(tsx?|jsx?|py|go|rs|java|sql)$/.test(String(entry['path']))
          ? 1
          : 2;
    return score(a) - score(b) || String(a['path']).localeCompare(String(b['path']));
  });
  let bytes = 0;
  let partial =
    tree['truncated'] === true || candidates.length > 20 || candidates.length < eligible.length;
  // Sequential requests keep local CPU/network load bounded and make limits explicit.
  for (const entry of candidates.slice(0, 20)) {
    let blob: Record<string, unknown>;
    try {
      blob = record(await read(`/repos/${fullName}/git/blobs/${string(entry['sha'])}`));
    } catch {
      partial = true;
      break;
    }
    if (blob['encoding'] !== 'base64') {
      partial = true;
      continue;
    }
    const data = Buffer.from(string(blob['content']), 'base64');
    if (
      data.length > 24_576 ||
      bytes + data.length > 262_144 ||
      data.includes(0) ||
      !isUtf8(data)
    ) {
      partial = true;
      continue;
    }
    bytes += data.length;
    context.files.push({
      path: string(entry['path']),
      sha: string(entry['sha']),
      size: data.length,
      text: redactRepositoryText(data.toString('utf8')),
    });
  }
  let recent: unknown = [];
  try {
    recent = await read(`/repos/${fullName}/issues?state=all&per_page=15&sort=updated`);
  } catch {
    partial = true;
  }
  if (!Array.isArray(recent)) throw new GitHubUnavailable('GitHub did not return issue metadata.');
  for (const value of recent) {
    const item = record(value);
    const metadata = {
      number: number(item['number']),
      title: redactRepositoryText(string(item['title'])),
      state: string(item['state']),
      url: string(item['html_url']),
    };
    (item['pull_request'] ? context.pullRequests : context.issues).push(metadata);
  }
  return { repository: repo, context, partial };
}
