import { GitHubRepositoryListSchema } from '@memvora/contracts';
import { apiRequest, resultResponse } from '@/lib/api';

export async function GET(request: Request) {
  const page = Number(new URL(request.url).searchParams.get('page') ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 100)
    return Response.json(
      { error: { message: 'Choose a valid repository page.' } },
      { status: 400 },
    );
  return resultResponse(
    await apiRequest(`/v1/github/repositories?page=${page}`, GitHubRepositoryListSchema),
  );
}
