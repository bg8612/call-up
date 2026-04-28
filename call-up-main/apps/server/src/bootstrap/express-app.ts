import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type CreateExpressAppOptions = {
  moduleUrl: string;
  getHealthSnapshot: () => Promise<{
    ok: boolean;
    rooms: number;
    status: 'ok' | 'degraded';
    issues: string[];
    uptimeSec: number;
    memory: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
    };
    metrics: Record<string, number>;
  }>;
};

export const createExpressApp = ({ moduleUrl, getHealthSnapshot }: CreateExpressAppOptions) => {
  const app = express();
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const webDistDir = join(currentDir, '../../web/dist');

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    res.json(await getHealthSnapshot());
  });

  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/socket\.io\/|\/health).*/, (_req, res) => {
      res.sendFile(join(webDistDir, 'index.html'));
    });
  }

  return app;
};
