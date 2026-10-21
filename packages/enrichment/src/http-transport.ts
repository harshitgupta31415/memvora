export function completionEndpoint(base: string): URL {
  let value: URL;
  try {
    value = new URL(base);
  } catch {
    throw new Error('AI_BASE_URL must identify a valid provider endpoint.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname);
  if (
    (value.protocol !== 'https:' && !(loopback && value.protocol === 'http:')) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  )
    throw new Error(
      'AI_BASE_URL must be HTTPS, or a loopback HTTP endpoint, without embedded credentials or query parameters.',
    );
  value.pathname = `${value.pathname.replace(/\/$/, '')}/chat/completions`;
  return value;
}

export async function boundedCompletionJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('AI response had no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 262_144) {
      await reader.cancel();
      throw new Error('AI response exceeded its size limit.');
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('AI response was not valid JSON.');
  }
}

export function completionContent(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('choices' in value) ||
    !Array.isArray(value.choices)
  )
    throw new Error('AI response did not contain a completion.');
  const choice: unknown = value.choices[0];
  if (
    typeof choice !== 'object' ||
    choice === null ||
    !('message' in choice) ||
    typeof choice.message !== 'object' ||
    choice.message === null ||
    !('content' in choice.message) ||
    typeof choice.message.content !== 'string'
  )
    throw new Error('AI response did not contain text.');
  if ('finish_reason' in choice && choice.finish_reason !== 'stop')
    throw new Error('AI completion was incomplete or refused.');
  return choice.message.content;
}
