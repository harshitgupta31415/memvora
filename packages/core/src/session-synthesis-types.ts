import type {
  CreateSessionSynthesis,
  LocalContext,
  SessionSynthesisAnalysis,
  SessionSynthesisConfiguration,
  SessionSynthesisInput,
  SessionSynthesisPreview,
  SessionSynthesisRequest,
  SessionSynthesisResponse,
} from '@memvora/contracts';

export interface SessionSynthesisJob {
  id: string;
  leaseToken: string;
  input: SessionSynthesisInput;
  inputHash: string;
  configuration: SessionSynthesisConfiguration;
}
export interface SessionSynthesizer {
  configuration: SessionSynthesisConfiguration;
  synthesize(input: SessionSynthesisInput): Promise<SessionSynthesisAnalysis>;
}
export interface SessionSynthesisStore {
  getSessionSynthesisPreview(
    context: LocalContext,
    sessionId: string,
    configuration: SessionSynthesisConfiguration | null,
  ): SessionSynthesisPreview;
  requestSessionSynthesis(
    context: LocalContext,
    sessionId: string,
    input: CreateSessionSynthesis,
    configuration: SessionSynthesisConfiguration | null,
  ): { request: SessionSynthesisRequest; created: boolean };
  getSessionSynthesis(
    context: LocalContext,
    sessionId: string,
    configuration: SessionSynthesisConfiguration | null,
    requestId?: string,
  ): SessionSynthesisResponse;
  claimSessionSynthesis(
    configuration: SessionSynthesisConfiguration | null,
  ): SessionSynthesisJob | null;
  completeSessionSynthesis(job: SessionSynthesisJob, analysis: SessionSynthesisAnalysis): boolean;
  failSessionSynthesis(job: SessionSynthesisJob): void;
}
