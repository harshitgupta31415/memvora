import { GitHubInstallationListSchema } from '@memvora/contracts';
import { apiRequest, resultResponse } from '@/lib/api';

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const raw = parameters.get('page') ?? '1';
  const page = /^\d{1,3}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (
    [...parameters.keys()].some((key) => key !== 'page') ||
    parameters.getAll('page').length > 1 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100
  )
    return Response.json(
      { error: { message: 'Choose a valid installation page.' } },
      { status: 400 },
    );
  return resultResponse(
    await apiRequest(`/v1/github/installations?page=${page}`, GitHubInstallationListSchema),
  );
}
