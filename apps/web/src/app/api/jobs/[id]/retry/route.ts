import { Compile } from 'typebox/compile';
import { IdSchema, JobResponseSchema, RetryJobSchema } from '@memvora/contracts';
import { apiRequest, readBoundedJson, resultResponse, trustedMutation } from '@/lib/api';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!trustedMutation(request))
    return Response.json(
      { error: { message: 'Only same-origin local requests are accepted.' } },
      { status: 403 },
    );
  const { id } = await params;
  if (!Compile(IdSchema).Check(id))
    return Response.json({ error: { message: 'Provide a valid job ID.' } }, { status: 400 });
  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch {
    return Response.json(
      { error: { message: 'Provide an empty JSON object to request a retry.' } },
      { status: 400 },
    );
  }
  if (!Compile(RetryJobSchema).Check(input))
    return Response.json(
      { error: { message: 'A retry accepts an empty JSON object only.' } },
      { status: 400 },
    );
  const result = await apiRequest(`/v1/jobs/${encodeURIComponent(id)}/retry`, JobResponseSchema, {
    method: 'POST',
    body: input,
  });
  return result.ok ? Response.json(result.data, { status: 202 }) : resultResponse(result);
}
