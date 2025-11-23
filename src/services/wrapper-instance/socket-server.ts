import net from 'node:net';

import type { InstanceRequest } from '@/types/instance-ipc.js';
import { KlaudeError } from '@/utils/error-handler.js';

import type { InstanceRequestHandler } from './types.js';
import { debugLog, ensureSocketClean } from './utils.js';

/**
 * Writes a JSON response to a socket connection
 * @param socket - The socket to write to
 * @param payload - The payload to serialize and send
 */
function writeSocketResponse(socket: net.Socket, payload: unknown): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Handles an incoming socket connection with request/response protocol
 * @param socket - The incoming socket connection
 * @param handler - The request handler to process incoming requests
 */
function handleSocketConnection(socket: net.Socket, handler: InstanceRequestHandler): void {
  socket.setEncoding('utf8');
  let buffer = '';
  let responded = false;

  const respond = (payload: unknown): void => {
    if (responded) {
      return;
    }
    responded = true;
    writeSocketResponse(socket, payload);
    socket.end();
  };

  const handleMessage = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return;
    }

    let request: InstanceRequest;
    try {
      request = JSON.parse(trimmed) as InstanceRequest;
    } catch {
      debugLog('Invalid JSON received');
      respond({
        ok: false,
        error: {
          code: 'E_INVALID_JSON',
          message: 'Invalid JSON payload',
        },
      });
      return;
    }

    const action = typeof (request as { action?: string }).action === 'string'
      ? (request as { action?: string }).action
      : 'unknown';
    const startTime = Date.now();
    debugLog(`[handler-start] action=${action}`);

    void (async () => {
      try {
        const result = await handler(request);
        const elapsed = Date.now() - startTime;
        debugLog(`[handler-end] action=${action}, elapsed=${elapsed}ms, ok=true`);
        respond({
          ok: true,
          result,
        });
      } catch (error) {
        const elapsed = Date.now() - startTime;
        if (error instanceof KlaudeError) {
          debugLog(
            `[handler-end] action=${action}, elapsed=${elapsed}ms, error=${error.code}`,
          );
          respond({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        debugLog(`[handler-error] action=${action}, elapsed=${elapsed}ms, message=${message}`);
        respond({
          ok: false,
          error: {
            code: 'E_INTERNAL',
            message,
          },
        });
      }
    })();
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const message = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleMessage(message);
      newlineIndex = buffer.indexOf('\n');
    }
  });

  socket.on('end', () => {
    if (buffer.length > 0) {
      handleMessage(buffer);
      buffer = '';
    }
  });

  socket.on('error', (error) => {
    console.error(`Instance socket connection error: ${error.message}`);
  });
}

/**
 * Starts a Unix socket server that handles instance IPC requests
 * @param socketPath - Path to the Unix socket
 * @param handler - The request handler to process incoming requests
 * @returns Promise that resolves to the server instance
 */
async function startInstanceServer(
  socketPath: string,
  handler: InstanceRequestHandler,
): Promise<net.Server> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleSocketConnection(socket, handler);
    });

    const handleError = (error: Error) => {
      server.close(() => {
        reject(error);
      });
    };

    server.once('error', handleError);

    server.listen(socketPath, () => {
      server.off('error', handleError);
      server.on('error', (err) => {
        console.error(`Instance socket error (${socketPath}): ${err.message}`);
      });
      resolve(server);
    });
  });
}

/**
 * Closes an instance server gracefully
 * @param server - The server to close
 * @returns Promise that resolves when the server is closed
 */
async function closeInstanceServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Socket server interface returned by createSocketServer
 */
export interface SocketServer {
  server: net.Server;
  cleanup: () => Promise<void>;
}

/**
 * Creates a Unix socket server with automatic cleanup handling
 * @param socketPath - Path to the Unix socket
 * @param handler - The request handler to process incoming requests
 * @returns Promise that resolves to a server object with cleanup method
 */
export async function createSocketServer(
  socketPath: string,
  handler: InstanceRequestHandler,
): Promise<SocketServer> {
  await ensureSocketClean(socketPath);

  const server = await startInstanceServer(socketPath, handler);

  return {
    server,
    cleanup: async () => {
      await closeInstanceServer(server);
    },
  };
}
