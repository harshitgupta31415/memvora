import { SystemStatusSchema } from '@memvora/contracts';
import { apiRequest, resultResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  return resultResponse(await apiRequest('/v1/system/status', SystemStatusSchema));
}
