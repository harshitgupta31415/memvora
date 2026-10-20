import { Compile } from 'typebox/compile';
import { CreateRepositorySchema, RepositoryResponseSchema } from '@memvora/contracts';
import { apiRequest, readBoundedJson, resultResponse, trustedMutation } from '@/lib/api';

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
  if (!Compile(CreateRepositorySchema).Check(input))
    return Response.json(
      { error: { message: 'Provide a repository name and valid optional path or remote URL.' } },
      { status: 400 },
    );
  return resultResponse(
    await apiRequest('/v1/repositories', RepositoryResponseSchema, { method: 'POST', body: input }),
  );
}
