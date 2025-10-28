import net from 'node:net';

import type {
  InstanceRequest,
  InstanceResponse,
  InstanceStatusPayload,
  StartAgentRequestPayload,
  StartAgentResponsePayload,
  CheckoutRequestPayload,
  MessageRequestPayload,
  InterruptRequestPayload,
} from '@/types/instance-ipc.js';

interface SendOptions {
  timeoutMs?: number;
}

function createTimeout(
  duration: number,
  onTimeout: () => void,
): NodeJS.Timeout {
  return setTimeout(onTimeout, duration).unref();
}

export async function sendInstanceRequest<T = unknown>(
  socketPath: string,
  request: InstanceRequest,
  options: SendOptions = {},
): Promise<InstanceResponse<T>> {
  const timeoutMs = options.timeoutMs ?? 2000;

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const clear = (): void => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    const finish = (payload: InstanceResponse<T>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clear();
      resolve(payload);
    };

    const handleParsedResponse = (raw: string): void => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as InstanceResponse<T>;
        finish(parsed);
      } catch {
        finish({
          ok: false,
          error: {
            code: 'E_INVALID_RESPONSE',
            message: 'Invalid response payload from instance',
          },
        });
      }
    };

    socket.setEncoding('utf8');

    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const message = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleParsedResponse(message);
        newlineIndex = buffer.indexOf('\n');
      }
    });

    socket.on('end', () => {
      if (buffer.length > 0) {
        handleParsedResponse(buffer);
        buffer = '';
      }
      if (!settled) {
        finish({
          ok: false,
          error: {
            code: 'E_NO_RESPONSE',
            message: 'Instance closed connection without response',
          },
        });
      }
    });

    socket.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clear();
      reject(error);
    });

    const timer = createTimeout(timeoutMs, () => {
      if (settled) {
        return;
      }
      settled = true;
      clear();
      resolve({
        ok: false,
        error: {
          code: 'E_TIMEOUT',
          message: `Timed out after ${timeoutMs}ms waiting for instance response`,
        },
      });
    });
  });
}

export async function pingInstance(
  socketPath: string,
  options?: SendOptions,
): Promise<InstanceResponse<{ pong: boolean; timestamp: string }>> {
  return await sendInstanceRequest(socketPath, { action: 'ping' }, options);
}

export async function getInstanceStatus(
  socketPath: string,
  options?: SendOptions,
): Promise<InstanceResponse<InstanceStatusPayload>> {
  return await sendInstanceRequest<InstanceStatusPayload>(
    socketPath,
    { action: 'status' },
    options,
  );
}

export async function startAgentSession(
  socketPath: string,
  payload: StartAgentRequestPayload,
  options?: SendOptions,
): Promise<InstanceResponse<StartAgentResponsePayload>> {
  return await sendInstanceRequest<StartAgentResponsePayload>(
    socketPath,
    { action: 'start-agent', payload },
    options,
  );
}

export async function requestCheckout(
  socketPath: string,
  payload: CheckoutRequestPayload,
  options?: SendOptions,
): Promise<InstanceResponse<unknown>> {
  return await sendInstanceRequest(
    socketPath,
    { action: 'checkout', payload },
    options,
  );
}

export async function sendAgentMessage(
  socketPath: string,
  payload: MessageRequestPayload,
  options?: SendOptions,
): Promise<InstanceResponse<unknown>> {
  return await sendInstanceRequest(
    socketPath,
    { action: 'message', payload },
    options,
  );
}

export async function interruptAgent(
  socketPath: string,
  payload: InterruptRequestPayload,
  options?: SendOptions,
): Promise<InstanceResponse<unknown>> {
  return await sendInstanceRequest(
    socketPath,
    { action: 'interrupt', payload },
    options,
  );
}
