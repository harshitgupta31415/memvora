import { GitHubRepositoryListSchema } from '@memvora/contracts';
import { apiRequest, resultResponse } from '@/lib/api';

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const rawPage = parameters.get('page') ?? '1';
  const page = /^\d{1,3}$/u.test(rawPage) ? Number(rawPage) : Number.NaN;
  const rawInstallation = parameters.get('installationId');
  const installationId =
    rawInstallation !== null && /^\d{1,16}$/u.test(rawInstallation)
      ? Number(rawInstallation)
      : Number.NaN;
  if (
    [...parameters.keys()].some((key) => key !== 'page' && key !== 'installationId') ||
    parameters.getAll('page').length > 1 ||
    parameters.getAll('installationId').length > 1 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100 ||
    (rawInstallation !== null && (!Number.isSafeInteger(installationId) || installationId < 1))
  )
    return Response.json(
      { error: { message: 'Choose a valid repository page.' } },
      { status: 400 },
    );
  const query = new URLSearchParams({ page: String(page) });
  if (rawInstallation !== null) query.set('installationId', String(installationId));
  return resultResponse(
    await apiRequest(`/v1/github/repositories?${query}`, GitHubRepositoryListSchema),
  );
}
