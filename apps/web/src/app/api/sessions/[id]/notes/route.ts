import { Compile } from 'typebox/compile';
import { CreateSessionNoteSchema, IdSchema, SessionNoteResponseSchema } from '@memvora/contracts';
import { apiRequest, readBoundedJson, resultResponse, trustedMutation } from '@/lib/api';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!trustedMutation(request))
    return Response.json(
      { error: { message: 'Only same-origin local requests are accepted.' } },
      { status: 403 },
    );
  const { id } = await params;
  if (!Compile(IdSchema).Check(id))
    return Response.json({ error: { message: 'Choose a valid investigation.' } }, { status: 400 });
  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch {
    return Response.json(
      { error: { message: 'Provide a valid bounded JSON request.' } },
      { status: 400 },
    );
  }
  if (!Compile(CreateSessionNoteSchema).Check(input) || !input.body.trim())
    return Response.json(
      {
        error: {
          message:
            'Provide a note ID, kind, 1–4000 characters of text, and up to 10 distinct command IDs.',
        },
      },
      { status: 400 },
    );
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(id)}/notes`,
    SessionNoteResponseSchema,
    { method: 'POST', body: input },
  );
  const response = result.ok
    ? Response.json(result.data, { status: result.status })
    : resultResponse(result);
  response.headers.set('cache-control', 'no-store');
  return response;
}
