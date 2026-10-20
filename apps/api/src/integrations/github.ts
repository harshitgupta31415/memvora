import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { DomainError, type LocalMemvora } from '@memvora/core';
import Type from 'typebox';
import {
  GitHubDisconnectSchema,
  GitHubInstallationListSchema,
  GitHubOAuthFinishSchema,
  GitHubOAuthStartSchema,
  GitHubStatusSchema,
} from '@memvora/contracts';
import type { GitHubOAuthSetup } from './github-oauth.js';
import {
  githubRepositories,
  githubUser,
  importGitHubContext,
  GitHubUnavailable,
} from './github-client.js';

/** All routes inherit the API's local bearer authentication and loopback origin checks. */
export function registerGitHubRoutes(
  instance: FastifyInstance,
  service: LocalMemvora,
  setup: GitHubOAuthSetup = {
    requested: false,
    callbackUrl: 'http://127.0.0.1:3000/api/github/oauth/callback',
    message: 'Register and configure a private GitHub App to enable browser authorization.',
  },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const importing = new Set<string>();
  let lastUser: { id: number; login: string; avatarUrl: string } | null = null;
  let checkedAt = 0;
  let boundGitHubId: number | null = null;
  async function identity() {
    const value = Date.now() - checkedAt < 15_000 && lastUser ? lastUser : await githubUser();
    if (boundGitHubId !== null && value.id !== boundGitHubId)
      throw new GitHubUnavailable(
        'The local GitHub identity changed. Restart and review repository access before importing.',
      );
    boundGitHubId ??= value.id;
    lastUser = value;
    checkedAt = Date.now();
    return value;
  }

  const oauthConnection = () => {
    if (!setup.connection) throw new DomainError('GITHUB_OAUTH_NOT_CONFIGURED', setup.message, 503);
    return setup.connection;
  };
  const pageQuery = Type.Object(
    { page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
    { additionalProperties: false },
  );
  const numericId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
  app.post(
    '/v1/github/oauth/start',
    {
      schema: {
        body: Type.Object(
          { browserHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) },
          { additionalProperties: false },
        ),
        response: { 200: GitHubOAuthStartSchema },
      },
    },
    async (request) => oauthConnection().start(service.context(), request.body.browserHash),
  );
  app.post(
    '/v1/github/oauth/finish',
    {
      schema: {
        body: Type.Object(
          {
            state: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
            browserHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
            code: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
            error: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: GitHubOAuthFinishSchema },
      },
    },
    async (request) => {
      if (Boolean(request.body.code) === Boolean(request.body.error))
        throw new DomainError(
          'INVALID_OAUTH_CALLBACK',
          'Supply exactly one authorization code or denial.',
        );
      return oauthConnection().finish(service.context(), request.body);
    },
  );
  app.post(
    '/v1/github/oauth/disconnect',
    {
      schema: {
        body: Type.Object({}, { additionalProperties: false }),
        response: { 200: GitHubDisconnectSchema },
      },
    },
    async () => {
      service.store.disconnectGitHub(service.context());
      return { disconnected: true as const };
    },
  );
  app.get(
    '/v1/github/installations',
    { schema: { querystring: pageQuery, response: { 200: GitHubInstallationListSchema } } },
    async (request) => {
      const oauth = oauthConnection();
      return oauth.run(service.context(), (token) =>
        oauth.provider.installations(token, request.query.page ?? 1),
      );
    },
  );
  app.get('/v1/github/status', { schema: { response: { 200: GitHubStatusSchema } } }, async () => {
    const context = service.context();
    const stored = setup.connection?.record(context) ?? null;
    const oauth = {
      configured: Boolean(setup.connection),
      callbackUrl: setup.callbackUrl,
      connected: Boolean(stored),
      user: stored?.user ?? null,
      expiresAt: stored?.expiresAt ? new Date(stored.expiresAt).toISOString() : null,
      message: setup.message,
    };
    if (setup.requested) {
      if (!setup.connection || !stored)
        return {
          available: false,
          mode: setup.connection ? ('github_app' as const) : ('unconfigured' as const),
          user: null,
          message: setup.connection
            ? 'Connect your GitHub account to browse authorized App installations.'
            : setup.message,
          oauth,
        };
      try {
        const user = await setup.connection.run(context, async (token, record) => {
          const user = await setup.connection!.provider.user(token);
          if (user.id !== record.user.id)
            throw new DomainError(
              'GITHUB_IDENTITY_MISMATCH',
              'The GitHub identity no longer matches this workspace connection.',
              409,
            );
          return user;
        });
        const current = setup.connection.record(context);
        return {
          available: true,
          mode: 'github_app' as const,
          user,
          message:
            'Using your private GitHub App connection. Select an authorized installation and repository to import.',
          oauth: {
            ...oauth,
            connected: true,
            user,
            expiresAt: current?.expiresAt ? new Date(current.expiresAt).toISOString() : null,
          },
        };
      } catch (error) {
        const current = setup.connection.record(context);
        return {
          available: false,
          mode: 'github_app' as const,
          user: null,
          message:
            error instanceof DomainError
              ? error.message
              : 'GitHub connection is temporarily unavailable.',
          oauth: { ...oauth, connected: Boolean(current), user: current?.user ?? null },
        };
      }
    }
    try {
      const user = await identity();
      return {
        available: true,
        mode: 'gh_cli' as const,
        user,
        message:
          'Using your existing local GitHub CLI authorization. Repository imports are explicit and bounded.',
        oauth,
      };
    } catch (error) {
      return {
        available: false,
        mode: 'unconfigured' as const,
        user: null,
        message:
          error instanceof GitHubUnavailable ? error.message : 'GitHub connection is unavailable.',
        oauth,
      };
    }
  });

  app.get(
    '/v1/github/repositories',
    {
      schema: {
        querystring: Type.Object(
          {
            page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            installationId: Type.Optional(numericId),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      if (setup.requested) {
        const oauth = oauthConnection();
        const installationId = request.query.installationId;
        if (!installationId)
          throw new DomainError(
            'GITHUB_INSTALLATION_REQUIRED',
            'Select an authorized GitHub App installation.',
          );
        return oauth.run(service.context(), async (token) => {
          const deadline = Date.now() + 15_000;
          await oauth.requireInstallation(token, installationId, deadline);
          const result = await oauth.provider.repositories(
            token,
            installationId,
            request.query.page ?? 1,
            oauth.remaining(deadline),
          );
          return {
            ...result,
            items: result.items.map((item) => ({
              ...item,
              installationId,
              accessPage: result.page,
            })),
          };
        });
      }
      if (request.query.installationId)
        throw new DomainError(
          'INVALID_REQUEST',
          'Installation selection requires a configured GitHub App connection.',
        );
      try {
        await identity();
        return await githubRepositories(request.query.page ?? 1);
      } catch {
        return reply.code(503).send({
          error: {
            code: 'GITHUB_UNAVAILABLE',
            message:
              'GitHub repositories could not be read. Check local authorization and network.',
            requestId: request.id,
            retryable: true,
          },
        });
      }
    },
  );

  app.post(
    '/v1/github/import',
    {
      schema: {
        body: Type.Object(
          {
            fullName: Type.String({ pattern: '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$', maxLength: 220 }),
            installationId: Type.Optional(numericId),
            repositoryId: Type.Optional(numericId),
            repositoryPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const fullName = request.body.fullName;
      if (importing.has(fullName.toLowerCase()))
        return reply.code(409).send({
          error: {
            code: 'IMPORT_RUNNING',
            message: 'This repository is already being imported.',
            requestId: request.id,
            retryable: true,
          },
        });
      importing.add(fullName.toLowerCase());
      try {
        const importContext = service.context();
        const canonicalRemote = `https://github.com/${fullName}`.toLowerCase();
        const sameRemote = (remote: string | null) =>
          remote
            ?.replace(/^git@github\.com:/iu, 'https://github.com/')
            .replace(/\/$/u, '')
            .replace(/\.git$/u, '')
            .toLowerCase() === canonicalRemote;
        // Capture a known target before remote I/O so deletion cannot turn an old request into a new repository.
        const originalRepository = service.store
          .repositories(importContext)
          .find((item) => sameRemote(item.remoteUrl));
        const originalGeneration = originalRepository
          ? service.store.repositoryGeneration(importContext, originalRepository.id)
          : undefined;
        let oauthRevision: number | undefined;
        let result: Awaited<ReturnType<typeof importGitHubContext>>;
        if (setup.requested) {
          const oauth = oauthConnection();
          const { installationId, repositoryId, repositoryPage } = request.body;
          if (!installationId || !repositoryId || !repositoryPage)
            throw new DomainError(
              'GITHUB_INSTALLATION_REQUIRED',
              'Select a repository from its authorized installation page.',
            );
          const selection = { installationId, repositoryId, repositoryPage, fullName };
          const imported = await oauth.run(importContext, async (token, connection) => {
            const deadline = Date.now() + 55_000;
            await oauth.requireRepository(token, selection, deadline);
            const result = await importGitHubContext(
              fullName,
              (path, timeout) =>
                oauth.provider.request(
                  token,
                  path,
                  Math.min(timeout ?? 15_000, oauth.remaining(deadline)),
                ),
              repositoryId,
            );
            if (result.repository.id !== repositoryId)
              throw new DomainError(
                'GITHUB_ACCESS_DENIED',
                'GitHub returned a different repository identity.',
                403,
              );
            await oauth.requireRepository(token, selection, deadline);
            return { result, revision: connection.revision };
          });
          result = imported.result;
          oauthRevision = imported.revision;
          oauth.assertCurrent(importContext, imported.revision);
        } else {
          if (
            request.body.installationId ||
            request.body.repositoryId ||
            request.body.repositoryPage
          )
            throw new DomainError(
              'INVALID_REQUEST',
              'Installation selection requires a configured GitHub App connection.',
            );
          await identity();
          result = await importGitHubContext(fullName);
        }
        const existing = originalRepository
          ? service.store.getRepository(importContext, originalRepository.id)
          : service.store
              .repositories(importContext)
              .find(
                (item) =>
                  item.remoteUrl === result.repository.url ||
                  item.remoteUrl === `${result.repository.url}.git`,
              );
        const repository =
          existing ??
          service.store.createRepository(importContext, {
            name: result.repository.fullName,
            remoteUrl: result.repository.url,
          });
        const context = {
          ...result.context,
          commitSha: result.context.commitSha || null,
          partial: result.partial,
        };
        service.store.saveRepositoryContext(
          importContext,
          repository.id,
          context,
          originalGeneration,
          oauthRevision,
        );
        return { repository, context, partial: result.partial };
      } catch (error) {
        if (error instanceof DomainError)
          return reply.code(error.statusCode).send({
            error: {
              code: error.code,
              message: error.message,
              requestId: request.id,
              retryable: error.retryable,
            },
          });
        // No raw CLI output, private contents or access token enter ordinary logs/errors.
        return reply.code(error instanceof GitHubUnavailable ? 503 : 400).send({
          error: {
            code: 'GITHUB_IMPORT_FAILED',
            message:
              error instanceof GitHubUnavailable
                ? error.message
                : 'Repository import could not be completed.',
            requestId: request.id,
            retryable: error instanceof GitHubUnavailable,
          },
        });
      } finally {
        importing.delete(fullName.toLowerCase());
      }
    },
  );

  app.get(
    '/v1/repositories/:id/context',
    {
      schema: {
        params: Type.Object(
          { id: Type.String({ format: 'uuid' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => ({ context: service.getRepositoryContext(request.params.id) }),
  );
}
