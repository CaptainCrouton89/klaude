/**
 * Types for instance IPC between CLI processes and wrapper instances.
 */

export type InstanceRequest =
  | { action: 'ping' }
  | { action: 'status' };

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
