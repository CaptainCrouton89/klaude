/**
 * Types for instance IPC between CLI processes and wrapper instances.
 */

export type InstanceRequest =
  | { action: 'ping' }
  | { action: 'status' }
  | { action: 'start-agent'; payload: StartAgentRequestPayload }
  | { action: 'checkout'; payload: CheckoutRequestPayload }
  | { action: 'message'; payload: MessageRequestPayload }
  | { action: 'interrupt'; payload: InterruptRequestPayload };

export interface StartAgentRequestPayload {
  agentType: string;
  prompt: string;
  agentCount?: number;
  parentSessionId?: string | null;
  options?: {
    checkout?: boolean;
    share?: boolean;
    detach?: boolean;
  };
}

export interface StartAgentResponsePayload {
  sessionId: string;
  status: 'active' | 'running' | 'done' | 'failed' | 'interrupted';
  logPath: string;
  agentType: string;
  prompt: string;
  createdAt: string;
  instanceId: string;
}

export interface CheckoutRequestPayload {
  sessionId?: string;
  waitSeconds?: number;
}

export interface CheckoutResponsePayload {
  sessionId: string;
  claudeSessionId: string;
}

export interface MessageRequestPayload {
  sessionId: string;
  prompt: string;
  waitSeconds?: number;
}

export interface InterruptRequestPayload {
  sessionId: string;
  signal?: NodeJS.Signals;
}

export interface InstanceStatusPayload {
  instanceId: string;
  projectHash: string;
  projectRoot: string;
  rootSessionId: string;
  sessionStatus: 'active' | 'running' | 'done' | 'failed' | 'interrupted';
  claudePid: number | null;
  updatedAt: string;
}

export type InstanceSuccessResponse<T = unknown> = {
  ok: true;
  result: T;
};

export type InstanceErrorResponse = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type InstanceResponse<T = unknown> = InstanceSuccessResponse<T> | InstanceErrorResponse;
