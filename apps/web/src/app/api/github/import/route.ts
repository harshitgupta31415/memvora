import { GitHubImportResponseSchema } from '@memvora/contracts';
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
  if (
    typeof input !== 'object' ||
    input === null ||
    !('fullName' in input) ||
    typeof input.fullName !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.fullName) ||
    Object.keys(input).length !== 1
  )
    return Response.json(
      { error: { message: 'Choose an owner/repository to import.' } },
      { status: 400 },
    );
  return resultResponse(
    await apiRequest('/v1/github/import', GitHubImportResponseSchema, {
      method: 'POST',
      body: { fullName: input.fullName },
      timeoutMs: 60_000,
    }),
  );
}
