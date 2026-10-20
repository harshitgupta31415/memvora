import { StringDecoder } from 'node:string_decoder';
import { redactText as redactBaseText } from '@memvora/core';

export function redactText(text: string, secrets: readonly string[] = []): string {
  let value = text;
  for (const secret of secrets) {
    if (secret.length >= 8) value = value.split(secret).join('[REDACTED]');
  }
  return redactBaseText(value);
}

export function redactArguments(
  args: readonly string[],
  secrets: readonly string[] = [],
): string[] {
  return args.map((argument, index) =>
    /^--(?:token|password|passwd|secret|api[-_]key|access[-_]key|client[-_]secret)$/i.test(
      args[index - 1] ?? '',
    )
      ? '[REDACTED]'
      : /^--(?:token|password|passwd|secret|api[-_]key|access[-_]key|client[-_]secret)=/i.test(
            argument,
          )
        ? `${argument.slice(0, argument.indexOf('=') + 1)}[REDACTED]`
        : redactText(argument, secrets),
  );
}

/** Complete lines are redacted before release, so split tokens never reach storage. */
export class StreamRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private line = '';
  private suppressedLongLine = false;
  private privateKey = false;
  private droppedBytes = 0;
  private previousWasCr = false;
  private previousCrSuppressed = false;

  get suppressedBytes(): number {
    return this.droppedBytes;
  }

  constructor(
    private readonly emit: (redacted: string) => void,
    private readonly secrets: readonly string[] = [],
    private readonly maxLineLength = 16_384,
  ) {}

  write(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (this.suppressedLongLine) this.emit('[REDACTED OVERLONG LINE]\n');
    else if (this.line) this.release(this.line);
    this.line = '';
    this.suppressedLongLine = false;
  }

  private consume(text: string): void {
    for (const character of text) {
      // Normalize CRLF once, including when the pair crosses process stream chunks.
      if (this.previousWasCr && character === '\n') {
        if (this.previousCrSuppressed) this.droppedBytes += 1;
        this.previousWasCr = false;
        this.previousCrSuppressed = false;
        continue;
      }
      this.previousWasCr = character === '\r';
      this.previousCrSuppressed = this.previousWasCr && this.suppressedLongLine;
      if (character === '\n' || character === '\r') {
        if (this.suppressedLongLine) {
          this.droppedBytes += Buffer.byteLength(character, 'utf8');
          this.emit('[REDACTED OVERLONG LINE]\n');
        } else if (this.line) this.release(`${this.line}\n`);
        else this.emit('\n');
        this.line = '';
        this.suppressedLongLine = false;
      } else if (!this.suppressedLongLine) {
        this.line += character;
        if (this.line.length > this.maxLineLength) {
          this.droppedBytes += Buffer.byteLength(this.line, 'utf8');
          this.line = '';
          this.suppressedLongLine = true;
        }
      } else this.droppedBytes += Buffer.byteLength(character, 'utf8');
    }
  }

  private release(line: string): void {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) this.privateKey = true;
    if (this.privateKey) {
      if (/-----END .*PRIVATE KEY-----/.test(line)) this.privateKey = false;
      this.emit('[REDACTED PRIVATE KEY]\n');
      return;
    }
    this.emit(redactText(line, this.secrets));
  }
}
