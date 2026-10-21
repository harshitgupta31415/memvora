import { IdSchema } from '@memvora/contracts';
import { Compile } from 'typebox/compile';
import { quotePowerShellArgument } from './setup-commands';

const id = Compile(IdSchema);
const states = ['unsynced', 'pending', 'incomplete', 'synced', 'all'] as const;
export type OutboxState = (typeof states)[number];

export type RecoveryInput = {
  directory: string;
  state: string;
  sessionId: string;
  after: string;
  syncKind: string;
  syncId: string;
};

export function captureRecoveryCommands(
  input: RecoveryInput,
  prefixes: { list: string; sync: string | null },
) {
  const errors = {
    directory:
      input.directory.length <= 2048 &&
      /^[A-Za-z]:[\\/]/u.test(input.directory) &&
      !input.directory.slice(2).includes(':') &&
      !/[\u0000-\u001f\u007f"<>|?*]/u.test(input.directory)
        ? null
        : 'Enter an absolute local Windows capture folder, such as C:\\Projects\\your-repository.',
    state: (states as readonly string[]).includes(input.state)
      ? null
      : 'Choose a listed outbox state.',
    sessionId:
      !input.sessionId || id.Check(input.sessionId)
        ? null
        : 'Enter a session UUID from the local outbox.',
    after:
      !input.after ||
      (/^[1-9]\d{0,15}$/u.test(input.after) && Number.isSafeInteger(Number(input.after)))
        ? null
        : 'Use the positive nextAfter row ID returned by the previous list page.',
    syncKind:
      input.syncKind === 'session' || input.syncKind === 'event'
        ? null
        : 'Choose session or event sync.',
    syncId: id.Check(input.syncId) ? null : 'Enter the exact session or event UUID to sync.',
  };
  const listArguments = [
    'outbox',
    'list',
    '--directory',
    input.directory,
    '--state',
    input.state,
    '--limit',
    '20',
    ...(input.sessionId ? ['--session', input.sessionId] : []),
    ...(input.after ? ['--after', input.after] : []),
  ];
  const listCommand =
    !errors.directory && !errors.state && !errors.sessionId && !errors.after
      ? `${prefixes.list} ${listArguments.map(quotePowerShellArgument).join(' ')}`
      : null;
  const syncCommand =
    prefixes.sync && !errors.directory && !errors.syncKind && !errors.syncId
      ? [
          '& {',
          `  Push-Location -LiteralPath ${quotePowerShellArgument(input.directory)} -ErrorAction Stop`,
          '  try {',
          `    ${prefixes.sync} ${quotePowerShellArgument(`--${input.syncKind}`)} ${quotePowerShellArgument(input.syncId)}`,
          '  } finally { Pop-Location }',
          '}',
        ].join('\n')
      : null;
  return { errors, listCommand, syncCommand };
}
