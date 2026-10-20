import { GitHubDisconnectSchema } from '@memvora/contracts';
import { apiRequest, readBoundedJson, resultResponse, trustedMutation } from '@/lib/api';

export async function POST(request: Request) {
  if (!trustedMutation(request))
    return Response.json(
      { error: { message: 'Only same-origin local requests are accepted.' } },
      { status: 403 },
    );
  try {
    const input = await readBoundedJson(request);
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).length !== 0
    )
      throw new Error('Invalid request.');
  } catch {
    return Response.json(
      { error: { message: 'Send an empty JSON object to disconnect local access.' } },
      { status: 400 },
    );
  }
  const response = resultResponse(
    await apiRequest('/v1/github/oauth/disconnect', GitHubDisconnectSchema, {
      method: 'POST',
      body: {},
    }),
  );
  response.headers.set('cache-control', 'no-store');
  return response;
}
