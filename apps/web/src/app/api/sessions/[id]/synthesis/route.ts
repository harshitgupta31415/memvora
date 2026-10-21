import { Compile } from 'typebox/compile';
import { CreateSessionSynthesisSchema, IdSchema } from '@memvora/contracts';
import { readBoundedJson, resultResponse, trustedLocalHost, trustedMutation } from '@/lib/api';
import { synthesisUrlQuery } from '@/lib/session-synthesis';
import { synthesisStatus } from '@/lib/session-synthesis-server';

function error(message: string, status: number): Response {
  return Response.json(
    { error: { message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!trustedLocalHost(request.headers.get('host')))
    return error('Only local requests are accepted.', 403);
  const { id } = await params;
  const query = synthesisUrlQuery(request.url);
  if (!Compile(IdSchema).Check(id) || !query)
    return error('Choose a valid investigation and optional request UUID.', 400);
  const response = resultResponse(await synthesisStatus(id, query.requestId));
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!trustedMutation(request)) return error('Only same-origin local requests are accepted.', 403);
  const { id } = await params;
  if (!Compile(IdSchema).Check(id) || new URL(request.url).search)
    return error('Choose a valid investigation without query parameters.', 400);
  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch {
    return error('Provide a valid bounded JSON request.', 400);
  }
  if (!Compile(CreateSessionSynthesisSchema).Check(input))
    return error('Provide a request UUID and the reviewed input hash.', 400);
  const result = await synthesisStatus(id, undefined, input);
  const response = result.ok
    ? Response.json(result.data, { status: result.status })
    : resultResponse(result);
  response.headers.set('cache-control', 'no-store');
  return response;
}
