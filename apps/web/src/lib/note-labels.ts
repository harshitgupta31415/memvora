import type { SessionNote } from '@memvora/contracts';

export function noteKindLabel(kind: SessionNote['kind']): string {
  return kind === 'resolution' ? 'Reported resolution' : kind === 'decision' ? 'Decision' : 'Note';
}
