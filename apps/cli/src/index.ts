#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { LocalContext, RecallAnswer, Session, SessionEventsPage } from '@memvora/contracts';
import { IdSchema, SessionEventsPageSchema, SessionEventsQuerySchema } from '@memvora/contracts';
import { Check } from 'typebox/value';
import {
  apiRequest,
  findBindingDirectory,
  LocalOutbox,
  readBinding,
  readToken,
  serverDataDir,
  writeBinding,
  type Binding,
} from './local.js';
import { captureCommand, recoverIncomplete } from './capture.js';
import { initializeRepository } from './initialization.js';
import { readExistingOutboxPage } from './outbox-inspection.js';
import { resolveSyncFilter, synchronizeOutbox } from './outbox-sync.js';
import { formatSessionRecap, readSessionRecap } from './session-recap.js';
import {
  readSessionDirectory,
  resolveSessionDirectoryRequest,
  type SessionListOptions,
} from './session-directory.js';
import {
  handoverFormat,
  readSessionHandoverDownload,
  writeSessionHandoverFile,
} from './session-export.js';
import {
  collectNoteEvent,
  formatRecallCitation,
  noteRetryError,
  prepareSessionNote,
  readSessionNotes,
  sessionNotesQuery,
  submitSessionNote,
  type NoteOptions,
} from './session-notes.js';

const program = new Command()
  .name('memvora')
  .version('0.2.0')
  .enablePositionalOptions()
  .description(
    'Capture explicit commands and recall cited engineering evidence through the authenticated local API.',
  )
  .option('--api-url <url>', 'Loopback API origin (or MEMVORA_API_URL)')
  .option(
    '--home <directory>',
    'Local server data directory containing local-token (or MEMVORA_DATA_DIR)',
  );

function connection(binding?: Binding): { origin: string; token: string } {
  const options = program.opts<{ apiUrl?: string; home?: string }>();
  return {
    origin:
      options.apiUrl ??
      process.env['MEMVORA_API_URL'] ??
      binding?.apiUrl ??
      'http://127.0.0.1:4000',
    token: readToken(options.home),
  };
}

function bound(): { root: string; binding: Binding } {
  const root = findBindingDirectory();
  if (!root) throw new Error('This directory is not bound. Run memvora init first.');
  return { root, binding: readBinding(root) };
}

function openOutbox(root: string): { outbox: LocalOutbox; path: string } {
  mkdirSync(join(root, '.memvora'), { recursive: true, mode: 0o700 });
  const path = join(root, '.memvora', 'outbox.sqlite');
  return { outbox: new LocalOutbox(path), path };
}

async function createSession(root: string, binding: Binding, title?: string): Promise<Binding> {
  const { origin, token } = connection(binding);
  const result = await apiRequest<{ session: Session }>(origin, token, '/v1/sessions', {
    repositoryId: binding.repositoryId,
    ...(title ? { title } : {}),
  });
  const updated = { ...binding, sessionId: result.session.id };
  writeBinding(root, updated);
  return updated;
}

function outboxInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Use a positive safe integer for ${label}.`);
  return Number(value);
}

program
  .command('outbox')
  .description('Inspect existing local capture metadata without API access or recovery.')
  .command('list')
  .option('--directory <path>', 'Capture project directory; bypass binding discovery')
  .option('--state <state>', 'unsynced, pending, incomplete, synced or all', 'unsynced')
  .option('--session <uuid>', 'Only this local investigation UUID')
  .option('--limit <count>', 'Rows per page, from 1 to 50', '20')
  .option('--after <row-id>', 'nextAfter from the previous page; live oldest-first pagination')
  .action(
    (options: {
      directory?: string;
      state: string;
      session?: string;
      limit: string;
      after?: string;
    }) => {
      const limit = outboxInteger(options.limit, '--limit');
      const after = outboxInteger(options.after, '--after');
      if (limit !== undefined && limit > 50) throw new Error('Use --limit from 1 to 50.');
      if (options.session !== undefined && !Check(IdSchema, options.session))
        throw new Error('Use a valid local session UUID.');
      if (!['unsynced', 'pending', 'incomplete', 'synced', 'all'].includes(options.state))
        throw new Error('Use --state unsynced, pending, incomplete, synced or all.');
      const root = options.directory ?? findBindingDirectory();
      if (!root)
        throw new Error('No capture binding found. Use --directory <capture-project-directory>.');
      console.log(
        JSON.stringify(
          readExistingOutboxPage({
            root,
            state: options.state as 'unsynced' | 'pending' | 'incomplete' | 'synced' | 'all',
            ...(options.session ? { sessionId: options.session } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(after !== undefined ? { after } : {}),
          }),
          null,
          2,
        ),
      );
    },
  );

program
  .command('status')
  .description('Show authenticated API identity, binding and local pending evidence.')
  .action(async () => {
    const root = findBindingDirectory();
    const binding = root ? readBinding(root) : undefined;
    const { origin, token } = connection(binding);
    const me = await apiRequest<LocalContext>(origin, token, '/v1/me');
    let local: { pending: number; incomplete: number } | undefined;
    if (root) {
      const { outbox } = openOutbox(root);
      try {
        local = outbox.counts();
      } finally {
        outbox.close();
      }
    }
    console.log(
      JSON.stringify(
        {
          api: origin,
          mode: me.mode,
          user: me.user.name,
          workspace: me.workspace.name,
          binding: binding ?? null,
          local: local ?? null,
        },
        null,
        2,
      ),
    );
  });

program
  .command('login')
  .description('Verify the local-development token; GitHub/device pairing is not implemented.')
  .action(async () => {
    const { origin, token } = connection();
    const me = await apiRequest<LocalContext>(origin, token, '/v1/me');
    console.log(
      `Local API access verified for ${me.user.name}. This is local development mode, not production login.`,
    );
    console.log(
      `Credential source: MEMVORA_LOCAL_TOKEN or ${join(serverDataDir(program.opts<{ home?: string }>().home), 'local-token')}. The credential is never printed.`,
    );
  });

program
  .command('init')
  .description(
    'Initialize a new local capture or verify an existing binding without changing its investigation.',
  )
  .option('--repository-id <id>', 'Bind an existing authorized local repository ID')
  .action(async (options: { repositoryId?: string }) => {
    const globalOptions = program.opts<{ apiUrl?: string; home?: string }>();
    const result = await initializeRepository({ ...options, ...globalOptions });
    if (result.mode === 'existing') {
      console.log(
        `Existing binding verified for repository ${result.binding.repositoryId}. Configuration, current investigation and local evidence were preserved.`,
      );
      if (result.sessionStatus === 'closed')
        console.log(
          'The bound investigation remains closed. Use memvora session start to begin another investigation.',
        );
      else if (result.sessionStatus === null)
        console.log('No investigation is currently bound. Use memvora session start to begin one.');
    } else {
      console.log(
        `Bound ${result.root} to local repository ${result.binding.repositoryId}; session ${result.binding.sessionId}.`,
      );
    }
    console.log(
      'Capture data is stored in .memvora. Keep this directory excluded from version control. GitHub authorization is not implied.',
    );
  });

const session = program
  .command('session')
  .description('Group captured commands into an investigation.');
session
  .command('list')
  .description(
    'Find authorized investigations by literal title and server-side filters; print one JSON page.',
  )
  .option('--query <title>', 'Literal title substring, up to 200 characters')
  .option('--repository <uuid>', 'Explicit authorized repository; bypass folder binding')
  .option('--all-repositories', 'Search the authorized workspace; bypass folder binding')
  .option('--status <status>', 'open or closed; closure does not verify a fix')
  .option('--limit <count>', 'Investigations per page, from 1 to 50', '20')
  .option(
    '--cursor <cursor>',
    'nextCursor from the prior page; keep the same filters; page size may change',
  )
  .action(async (options: SessionListOptions) => {
    const { input, binding } = resolveSessionDirectoryRequest(options);
    const { origin, token } = connection(binding);
    console.log(JSON.stringify(await readSessionDirectory(origin, token, input), null, 2));
  });
session.command('start [title]').action(async (title?: string) => {
  const { root, binding } = bound();
  const updated = await createSession(root, binding, title);
  console.log(`Started session ${updated.sessionId}.`);
});
session.command('end').action(async () => {
  const { root, binding } = bound();
  if (!binding.sessionId) throw new Error('No current session.');
  const { origin, token } = connection(binding);
  await apiRequest(origin, token, `/v1/sessions/${binding.sessionId}/close`, {});
  const { sessionId: ended, ...remaining } = binding;
  writeBinding(root, remaining);
  console.log(`Ended session ${ended}. This does not mark the issue fixed.`);
});
session
  .command('show [id]')
  .description(
    'Read an investigation page as JSON; defaults to the latest attempts of the bound session.',
  )
  .option('--limit <count>', 'Events per page, from 1 to 50', '20')
  .option('--cursor <cursor>', 'Older or newer cursor from the previous page; keep the same limit')
  .action(async (id: string | undefined, options: { limit: string; cursor?: string }) => {
    const query = {
      limit: /^\d+$/.test(options.limit) ? Number(options.limit) : Number.NaN,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    };
    if (!Check(SessionEventsQuerySchema, query))
      throw new Error(
        'Use a page limit from 1 to 50 and a nonempty cursor of at most 2048 characters.',
      );
    const binding = id ? undefined : bound().binding;
    const sessionId = id ?? binding?.sessionId;
    if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
    const { origin, token } = connection(binding);
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.cursor) params.set('cursor', query.cursor);
    const result = await apiRequest<SessionEventsPage>(
      origin,
      token,
      `/v1/sessions/${sessionId}/events?${params.toString()}`,
    );
    if (!Check(SessionEventsPageSchema, result))
      throw new Error('Session response failed the shared runtime contract.');
    console.log(JSON.stringify(result, null, 2));
  });

session
  .command('recap [id]')
  .description('Read a cited observed recap of the investigation; no fix is inferred.')
  .option('--json', 'Print the validated bounded recap as JSON')
  .action(async (id: string | undefined, options: { json?: boolean }) => {
    const binding = id ? undefined : bound().binding;
    const sessionId = id ?? binding?.sessionId;
    if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
    const { origin, token } = connection(binding);
    const result = await readSessionRecap(origin, token, sessionId);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionRecap(result));
  });

session
  .command('export [id]')
  .description(
    'Export one portable cited investigation; no upload, open or overwrite is performed.',
  )
  .option('--format <format>', 'markdown or json', 'markdown')
  .option('--output <path>', 'Create a new file exclusively; defaults to stdout')
  .action(async (id: string | undefined, options: { format: string; output?: string }) => {
    const format = handoverFormat(options.format);
    const binding = id ? undefined : bound().binding;
    const sessionId = id ?? binding?.sessionId;
    if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
    const { origin, token } = connection(binding);
    const download = await readSessionHandoverDownload(origin, token, sessionId, format);
    if (options.output !== undefined) {
      writeSessionHandoverFile(options.output, download.content);
      console.error(`Saved ${download.filename} to the requested new file.`);
    } else {
      process.stdout.write(download.content);
    }
  });

session
  .command('note [session-id]')
  .description('Add an explicitly user-authored note, decision or resolution claim.')
  .requiredOption('--text <body>', 'User-authored journal text, up to 4000 characters')
  .option(
    '--kind <kind>',
    'note, decision or resolution; none independently verifies a fix',
    'note',
  )
  .option(
    '--event <uuid>',
    'Link a captured event UUID; repeat up to ten times',
    collectNoteEvent,
    [],
  )
  .option('--note-id <uuid>', 'Reuse this note UUID when retrying the same submission')
  .action(async (id: string | undefined, options: NoteOptions) => {
    if (id !== undefined && !Check(IdSchema, id))
      throw new Error('An authorized session UUID is required.');
    const input = prepareSessionNote(options);
    try {
      const binding = id ? undefined : bound().binding;
      const sessionId = id ?? binding?.sessionId;
      if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
      const { origin, token } = connection(binding);
      const result = await submitSessionNote(origin, token, sessionId, input);
      console.log(JSON.stringify(result, null, 2));
    } catch {
      throw noteRetryError(input.id);
    }
  });

session
  .command('notes [id]')
  .description('Read a validated chronological journal page as JSON.')
  .option('--limit <count>', 'Notes per page, from 1 to 50', '20')
  .option('--before <uuid>', 'olderBeforeId from the previous page')
  .action(async (id: string | undefined, options: { limit: string; before?: string }) => {
    const query = sessionNotesQuery(options.limit, options.before);
    const binding = id ? undefined : bound().binding;
    const sessionId = id ?? binding?.sessionId;
    if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
    const { origin, token } = connection(binding);
    console.log(JSON.stringify(await readSessionNotes(origin, token, sessionId, query), null, 2));
  });

program
  .command('run')
  .description(
    'Capture one explicit, noninteractive command. stdin is disabled; arbitrary terminal history is not captured.',
  )
  .option(
    '--shell <shell>',
    'Explicit shell: cmd or powershell; pass one quoted command string after --',
  )
  .argument('<command...>', 'Executable and literal argument array, after --')
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (command: string[], options: { shell?: string }) => {
    if (
      command.length > 257 ||
      command[0]!.length > 4096 ||
      command.slice(1).some((arg) => arg.length > 8192)
    )
      throw new Error('Command exceeds supported argument limits.');
    const { root, binding: initial } = bound();
    const binding = initial.sessionId ? initial : await createSession(root, initial);
    const { token } = connection(binding);
    const { outbox, path } = openOutbox(root);
    try {
      const recovered = recoverIncomplete(outbox, { sessionId: binding.sessionId! });
      if (recovered) console.error(`Recovered ${recovered} interrupted capture(s) as incomplete.`);
      const result = await captureCommand({
        cwd: process.cwd(),
        repositoryId: binding.repositoryId,
        sessionId: binding.sessionId!,
        outbox,
        token,
        command,
        ...(options.shell ? { shell: options.shell } : {}),
        databasePath: path,
      });
      process.exitCode = result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : 1;
      try {
        const synced = await synchronizeOutbox(outbox, binding, connection(binding), {
          eventId: result.eventId,
        });
        console.error(
          `Acknowledged ${synced.acknowledgedEvents} event(s); ${synced.totalRemaining.pending} finalized event(s) remain pending in the local outbox.`,
        );
      } catch (error) {
        console.error(
          `Sync deferred; evidence remains local: ${error instanceof Error ? error.message : 'API unavailable'}`,
        );
      }
    } finally {
      outbox.close();
    }
  });

program
  .command('sync')
  .description('Retry immutable pending events; acknowledge only exact committed IDs.')
  .option('--session <uuid>', 'Only finalized pending events from this local investigation')
  .option('--event <uuid>', 'Only this finalized pending event; mutually exclusive with --session')
  .action(async (options: { session?: string; event?: string }) => {
    const filter = resolveSyncFilter(options.session, options.event);
    const { root, binding } = bound();
    const access = connection(binding);
    const { outbox } = openOutbox(root);
    try {
      // Selected retries never probe or finalize unrelated unfinished captures.
      const recoveredIncompleteCaptures = filter ? 0 : recoverIncomplete(outbox);
      console.log(
        JSON.stringify(
          {
            ...(await synchronizeOutbox(outbox, binding, access, filter)),
            recoveredIncompleteCaptures,
          },
          null,
          2,
        ),
      );
    } finally {
      outbox.close();
    }
  });

program
  .command('ask')
  .description('Retrieve earlier engineering evidence with citations.')
  .argument('<question...>')
  .option(
    '--repository <id>',
    'Narrow recall to an authorized repository ID instead of the current binding.',
  )
  .action(async (question: string[], options: { repository?: string }) => {
    if (options.repository && !Check(IdSchema, options.repository))
      throw new Error('Provide a valid repository UUID.');
    const root = options.repository ? undefined : findBindingDirectory();
    const binding = root ? readBinding(root) : undefined;
    const { origin, token } = connection(binding);
    const repositoryId = options.repository ?? binding?.repositoryId;
    const answer = await apiRequest<RecallAnswer>(origin, token, '/v1/ask', {
      query: question.join(' '),
      ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
    });
    console.log(`${answer.label}\n\n${answer.answer}`);
    for (const [index, step] of answer.steps.entries())
      console.log(`${index + 1}. ${step.text}\n   Sources: ${step.sourceIds.join(', ')}`);
    if (answer.uncertainty.length) console.log(`\nUncertainty: ${answer.uncertainty.join(' ')}`);
    for (const source of answer.sources) console.log(formatRecallCitation(source));
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Memvora command failed.');
  process.exitCode = 1;
}
