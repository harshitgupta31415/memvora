import { GitHubImportResponseSchema } from '@memvora/contracts';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { apiRequest, readBoundedJson, resultResponse, trustedMutation } from '@/lib/api';

const numericId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const fullName = Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', maxLength: 220 });
const ImportInput = Type.Union([
  Type.Object({ fullName }, { additionalProperties: false }),
  Type.Object(
    {
      fullName,
      installationId: numericId,
      repositoryId: numericId,
      repositoryPage: Type.Integer({ minimum: 1, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
]);

export async function POST(request: Request) {
  if (!trustedMutation(request))
    return Response.json(
      { error: { message: 'Only same-origin local requests are accepted.' } },
      { status: 403 },
    );
  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch {
    return Response.json(
      { error: { message: 'Provide a valid bounded JSON request.' } },
      { status: 400 },
    );
  }
  if (!Compile(ImportInput).Check(input))
    return Response.json(
      { error: { message: 'Choose an owner/repository to import.' } },
      { status: 400 },
    );
  return resultResponse(
    await apiRequest('/v1/github/import', GitHubImportResponseSchema, {
      method: 'POST',
      body: input,
      timeoutMs: 60_000,
    }),
  );
}
