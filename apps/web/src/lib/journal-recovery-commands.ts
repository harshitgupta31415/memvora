import { IdSchema } from '@memvora/contracts';
import { Compile } from 'typebox/compile';
import { quotePowerShellArgument } from './setup-commands';

const id = Compile(IdSchema);
const states = ['pending', 'synced', 'all'] as const;

export type JournalRecoveryInput = {
  directory: string;
  state: string;
  after: string;
  noteId: string;
};

export function journalRecoveryCommands(
  input: JournalRecoveryInput,
  prefixes: { list: string; retry: string | null },
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
      : 'Choose pending, synced or all journal notes.',
    after:
      !input.after ||
      (/^[1-9]\d{0,15}$/u.test(input.after) && Number.isSafeInteger(Number(input.after)))
        ? null
        : 'Use the positive nextAfter row ID returned by the previous journal list page.',
    noteId: id.Check(input.noteId)
      ? null
      : 'Enter the exact note UUID from the local journal list.',
  };
  const listArguments = [
    'journal',
    'list',
    '--directory',
    input.directory,
    '--state',
    input.state,
    '--limit',
    '20',
    ...(input.after ? ['--after', input.after] : []),
  ];
  const listCommand =
    !errors.directory && !errors.state && !errors.after
      ? `${prefixes.list} ${listArguments.map(quotePowerShellArgument).join(' ')}`
      : null;
  const retryCommand =
    prefixes.retry && !errors.directory && !errors.noteId
      ? [
          '& {',
          `  Push-Location -LiteralPath ${quotePowerShellArgument(input.directory)} -ErrorAction Stop`,
          '  try {',
          `    ${prefixes.retry} ${quotePowerShellArgument('--note')} ${quotePowerShellArgument(input.noteId)}`,
          '  } finally { Pop-Location }',
          '}',
        ].join('\n')
      : null;
  return { errors, listCommand, retryCommand };
}
