import { Compile } from 'typebox/compile';
import { IdSchema } from '@memvora/contracts';
import { resultResponse, trustedLocalHost } from '@/lib/api';
import { synthesisPreview } from '@/lib/session-synthesis-server';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!trustedLocalHost(request.headers.get('host')))
    return Response.json(
      { error: { message: 'Only local requests are accepted.' } },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  if (!Compile(IdSchema).Check(id) || new URL(request.url).search)
    return Response.json(
      { error: { message: 'Choose a valid investigation without query parameters.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  const response = resultResponse(await synthesisPreview(id));
  response.headers.set('cache-control', 'no-store');
  return response;
}
