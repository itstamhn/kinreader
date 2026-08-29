import { registerRoutes } from 'kitcn/auth/http';
import { httpRouter } from 'convex/server';
import { getAuth } from './generated/auth';
import { getEnv } from '../lib/get-env';

const http = httpRouter();

registerRoutes(http, getAuth, {
  cors: {
    allowedOrigins: [
      getEnv().SITE_URL,
      'http://localhost:3000',
      'https://app.kinreader.com',
      'https://kinreader.com',
    ],
  },
});

export default http;
