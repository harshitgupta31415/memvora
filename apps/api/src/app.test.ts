import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('public scaffold endpoints', () => {
  it('reports liveness without requiring credentials or a database', async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'memvora-api' });
  });

  it('does not claim product integrations work or accept evidence', async () => {
    const app = buildApp();
    apps.push(app);
    const status = await app.inject({ method: 'GET', url: '/v1/system/status' });
    expect(status.statusCode).toBe(200);
    const payload = status.json<{
      stage: string;
      capabilities: { id: string; status: string }[];
    }>();
    expect(payload.stage).toBe('scaffold');
    expect(payload.capabilities.find((item) => item.id === 'capture')?.status).toBe('planned');
    expect(payload.capabilities.find((item) => item.id === 'retrieval')?.status).toBe('planned');
    expect(
      (await app.inject({ method: 'POST', url: '/v1/events/batch', payload: { events: [] } }))
        .statusCode,
    ).toBe(503);
  });
});
