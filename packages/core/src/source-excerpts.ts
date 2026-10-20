import type { RepositorySourceMatch } from '@memvora/contracts';

/** Shorter adapters must keep their line range consistent with the returned text. */
export function clipRepositorySourceMatch(
  match: RepositorySourceMatch,
  maxCharacters = 4000,
): RepositorySourceMatch {
  if (match.excerpt.length <= maxCharacters) return match;
  let excerpt = match.excerpt.slice(0, maxCharacters);
  const lastBreak = Math.max(excerpt.lastIndexOf('\n'), excerpt.lastIndexOf('\r'));
  if (lastBreak > 0) excerpt = excerpt.slice(0, lastBreak).replace(/\r$/, '');
  // Avoid ending an excerpt halfway through a UTF-16 surrogate pair.
  if (/[\uD800-\uDBFF]$/u.test(excerpt)) excerpt = excerpt.slice(0, -1);
  return {
    ...match,
    excerpt,
    endLine: Math.min(match.endLine, match.startLine + excerpt.split(/\r\n|\r|\n/u).length - 1),
    excerptTruncated: true,
  };
}
