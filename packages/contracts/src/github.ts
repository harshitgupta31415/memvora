import Type from 'typebox';
import { RepositoryContextSchema, RepositorySchema } from './local.js';

const object = <T extends Record<string, Type.TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const GitHubUserSchema = object({
  id: Type.Integer(),
  login: Type.String(),
  avatarUrl: Type.String(),
});
export type GitHubUser = Type.Static<typeof GitHubUserSchema>;
export const GitHubStatusSchema = object({
  available: Type.Boolean(),
  mode: Type.Union([
    Type.Literal('gh_cli'),
    Type.Literal('github_app'),
    Type.Literal('unconfigured'),
  ]),
  user: Type.Union([GitHubUserSchema, Type.Null()]),
  message: Type.String(),
  oauth: object({
    configured: Type.Boolean(),
    callbackUrl: Type.String(),
    connected: Type.Boolean(),
    user: Type.Union([GitHubUserSchema, Type.Null()]),
    expiresAt: Type.Union([Type.String(), Type.Null()]),
    message: Type.String(),
  }),
});
export type GitHubStatus = Type.Static<typeof GitHubStatusSchema>;
export const GitHubRepositorySchema = object({
  id: Type.Integer(),
  fullName: Type.String(),
  name: Type.String(),
  private: Type.Boolean(),
  description: Type.Union([Type.String(), Type.Null()]),
  defaultBranch: Type.String(),
  url: Type.String(),
  installationId: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  accessPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type GitHubRepository = Type.Static<typeof GitHubRepositorySchema>;
export const GitHubInstallationSchema = object({
  id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  accountLogin: Type.String(),
  appId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  repositorySelection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
  suspended: Type.Boolean(),
});
export type GitHubInstallation = Type.Static<typeof GitHubInstallationSchema>;
export const GitHubInstallationListSchema = object({
  items: Type.Array(GitHubInstallationSchema),
  page: Type.Integer({ minimum: 1, maximum: 100 }),
  hasMore: Type.Boolean(),
});
export const GitHubOAuthStartSchema = object({
  authorizationUrl: Type.String(),
  expiresAt: Type.String(),
  callbackUrl: Type.String(),
});
export const GitHubOAuthFinishSchema = object({
  status: Type.Union([Type.Literal('connected'), Type.Literal('denied')]),
  user: Type.Union([GitHubUserSchema, Type.Null()]),
});
export const GitHubDisconnectSchema = object({ disconnected: Type.Literal(true) });
export const GitHubRepositoryListSchema = object({
  items: Type.Array(GitHubRepositorySchema),
  page: Type.Integer(),
  hasMore: Type.Boolean(),
});
export const GitHubImportResponseSchema = object({
  repository: RepositorySchema,
  context: RepositoryContextSchema,
  partial: Type.Boolean(),
});
export const RepositoryContextResponseSchema = object({
  context: Type.Union([RepositoryContextSchema, Type.Null()]),
});
