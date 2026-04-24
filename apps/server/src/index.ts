import { createAppServer } from './server.js';

const port = Number(process.env.PORT ?? 3001);
const { httpServer } = createAppServer();

httpServer.listen(port, () => {
  console.log(`Mini Meet server listening on http://localhost:${port}`);
});
