import { Buffer } from 'node:buffer';
import { Compile } from 'typebox/compile';
import { IdSchema, SessionHandoverDownloadSchema } from '@memvora/contracts';
import { apiRequest, resultResponse, trustedLocalHost } from '@/lib/api';

function privateResponse(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!trustedLocalHost(request.headers.get('host')))
    return privateResponse(
      Response.json({ error: { message: 'Use a trusted local address.' } }, { status: 403 }),
    );
  const { id } = await params;
  const parameters = new URL(request.url).searchParams;
  const format = parameters.get('format') ?? 'markdown';
  if (
    !Compile(IdSchema).Check(id) ||
    parameters.getAll('format').length > 1 ||
    [...parameters.keys()].some((key) => key !== 'format') ||
    (format !== 'json' && format !== 'markdown')
  )
    return privateResponse(
      Response.json(
        { error: { message: 'Choose a valid investigation and one format: markdown or json.' } },
        { status: 400 },
      ),
    );
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(id)}/handover/download?format=${format}`,
    SessionHandoverDownloadSchema,
    { timeoutMs: 30_000 },
  );
  if (!result.ok) return privateResponse(resultResponse(result));
  const filename = `memvora-handover-${id}.${format === 'json' ? 'json' : 'md'}`;
  const mediaType = format === 'json' ? 'application/json' : 'text/markdown';
  if (
    result.data.format !== format ||
    result.data.filename !== filename ||
    result.data.mediaType !== mediaType ||
    Buffer.byteLength(result.data.content, 'utf8') > 8 * 1024 * 1024
  )
    return privateResponse(
      Response.json(
        { error: { message: 'The handover download did not match the requested report.' } },
        { status: 502 },
      ),
    );
  return privateResponse(
    new Response(result.data.content, {
      headers: {
        'content-type': `${mediaType}; charset=utf-8`,
        'content-disposition': `attachment; filename="${filename}"`,
      },
    }),
  );
}
