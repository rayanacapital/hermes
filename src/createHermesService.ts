import findMyWay from 'find-my-way';
import http, { IncomingMessage, ServerResponse } from 'http';
import { debug } from './debug';
import { App, DISABLED, HttpRequest, TemplatedApp, WebSocket } from 'uWebSockets.js';
import { healthCheck } from './http';

const pkg = require('../package.json');

export interface HermesServiceOptions {
  httpRoutes?: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    handler: (message: IncomingMessage, res: ServerResponse) => void;
  }[];
  wsRoutes?: { [key: string]: (ws: WebSocket, req: HttpRequest) => void };
}

export class HermesService {
  private readonly _httpServer: http.Server;
  private readonly _wsServer: TemplatedApp;
  private _eventLoopTimerId: NodeJS.Timeout | undefined = undefined;

  constructor(private readonly options: HermesServiceOptions) {
    const router = findMyWay({ ignoreTrailingSlash: true });

    this._httpServer = http.createServer((req, res) => {
      router.lookup(req, res);
    });

    // set timeout to 0 meaning infinite http timout - streaming may take some time expecially for longer date ranges
    this._httpServer.timeout = 0;

    router.on('GET', '/health-check', healthCheck);

    if (options.httpRoutes) {
      for (const route of options.httpRoutes) {
        router.on(route.method, route.path, route.handler);
      }
    }

    const wsRoutes = options.wsRoutes || {};

    this._wsServer = App().ws('/*', {
      compression: DISABLED,
      maxPayloadLength: 512 * 1024,
      idleTimeout: 60,
      maxBackpressure: 5 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      upgrade: (res: any, req: any, context: any) => {
        res.upgrade(
          { req },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context,
        );
      },
      open: (ws: WebSocket) => {
        const path = ws.req.getUrl().toLocaleLowerCase();
        ws.closed = false;
        const matchingRoute = wsRoutes[path];

        if (matchingRoute !== undefined) {
          matchingRoute(ws, ws.req);
        } else {
          ws.end(1008);
        }
      },

      message: (ws: WebSocket, message: ArrayBuffer) => {
        if (ws.onmessage !== undefined) {
          ws.onmessage(message);
        }
      },

      close: (ws: WebSocket) => {
        ws.closed = true;
        if (ws.onclose !== undefined) {
          ws.onclose();
        }
      },
    } as any);
  }

  public async start(port: number) {
    let start = process.hrtime();
    const interval = 500;

    // based on https://github.com/tj/node-blocked/blob/master/index.js
    this._eventLoopTimerId = setInterval(() => {
      const delta = process.hrtime(start);
      const nanosec = delta[0] * 1e9 + delta[1];
      const ms = nanosec / 1e6;
      const n = ms - interval;

      if (n > 2000) {
        debug('Hermes server event loop blocked for %d ms.', Math.round(n));
      }

      start = process.hrtime();
    }, interval);

    await new Promise<void>((resolve, reject) => {
      try {
        this._httpServer.on('error', reject);
        this._httpServer.listen(port, () => {
          this._wsServer.listen(port + 1, (listenSocket) => {
            if (listenSocket) {
              resolve();
            } else {
              reject(new Error('ws server did not start'));
            }
          });
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  public async stop() {
    await new Promise<void>((resolve, reject) => {
      this._httpServer.close((err) => {
        err ? reject(err) : resolve();
      });
    });

    if (this._eventLoopTimerId !== undefined) {
      clearInterval(this._eventLoopTimerId);
    }
  }
}

export const createHermesService = (options: HermesServiceOptions) => {
  return new HermesService(options);
};
