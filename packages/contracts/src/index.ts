import Type from 'typebox';

export * from './local.js';
export * from './github.js';

export const HealthSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    service: Type.Literal('memvora-api'),
  },
  { additionalProperties: false },
);
export type Health = Type.Static<typeof HealthSchema>;

export const CapabilitySchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal('github'),
      Type.Literal('capture'),
      Type.Literal('memory'),
      Type.Literal('retrieval'),
      Type.Literal('mcp'),
    ]),
    label: Type.String(),
    status: Type.Union([
      Type.Literal('planned'),
      Type.Literal('scaffold'),
      Type.Literal('implemented'),
      Type.Literal('limited'),
    ]),
    detail: Type.String(),
  },
  { additionalProperties: false },
);
export type Capability = Type.Static<typeof CapabilitySchema>;

export const SystemStatusSchema = Type.Object(
  {
    product: Type.Literal('Memvora'),
    stage: Type.Union([Type.Literal('scaffold'), Type.Literal('local_mvp')]),
    capabilities: Type.Array(CapabilitySchema),
  },
  { additionalProperties: false },
);
export type SystemStatus = Type.Static<typeof SystemStatusSchema>;
