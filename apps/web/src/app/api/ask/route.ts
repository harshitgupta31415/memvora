import { Compile } from 'typebox/compile';
import { AskRequestSchema, RecallAnswerSchema } from '@memvora/contracts';
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
  if (!Compile(AskRequestSchema).Check(input))
    return Response.json(
      {
        error: {
          message: 'Provide a question of at most 2,000 characters and a valid repository scope.',
        },
      },
      { status: 400 },
    );
  return resultResponse(
    await apiRequest('/v1/ask', RecallAnswerSchema, { method: 'POST', body: input }),
  );
}
