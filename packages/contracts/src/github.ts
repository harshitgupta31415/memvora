import Type from 'typebox';
import { RepositoryContextSchema, RepositorySchema } from './local.js';

const object = <T extends Record<string, Type.TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const GitHubUserSchema = object({
  id: Type.Integer(),
  login: Type.String(),
  avatarUrl: Type.String(),
});
export const GitHubStatusSchema = object({
  available: Type.Boolean(),
  mode: Type.Union([Type.Literal('gh_cli'), Type.Literal('unconfigured')]),
  user: Type.Union([GitHubUserSchema, Type.Null()]),
  message: Type.String(),
  oauth: object({ configured: Type.Boolean(), callbackUrl: Type.String() }),
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
});
export type GitHubRepository = Type.Static<typeof GitHubRepositorySchema>;
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
