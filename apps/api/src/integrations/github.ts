import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { DomainError, type LocalMemvora } from '@memvora/core';
import Type from 'typebox';
import {
  githubRepositories,
  githubUser,
  importGitHubContext,
  GitHubUnavailable,
} from './github-client.js';

/** All routes inherit the API's local bearer authentication and loopback origin checks. */
export function registerGitHubRoutes(instance: FastifyInstance, service: LocalMemvora): void {
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

  app.get('/v1/github/status', async () => {
    const oauth = {
      configured: Boolean(process.env['GITHUB_CLIENT_ID'] && process.env['GITHUB_CLIENT_SECRET']),
      callbackUrl: 'http://127.0.0.1:4000/v1/auth/github/callback',
    };
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
          { page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
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
        await identity();
        const result = await importGitHubContext(fullName);
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
