import { assertWorkersMongooseVersion } from './runtime-compat.js';

/**
 * Hosts the existing Express application and its Mongoose connection in one
 * Durable Object. This is deliberately a single named instance: MongoDB TCP
 * connections cannot be shared between ordinary Worker invocations.
 *
 * The application is imported only after Worker bindings have been copied to
 * process.env and the Mongoose runtime compatibility gate has passed.
 */
export class BackendRuntime {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.runtimePromise = null;
    this.connectPromise = null;
  }

  setRuntimeEnvironment() {
    for (const [key, value] of Object.entries(this.env)) {
      if (typeof value === 'string') process.env[key] = value;
    }
    process.env.SAFARIBET_WORKER_RUNTIME = '1';
    process.env.SB_NO_SWEEP = '1';
  }

  async initialize() {
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        this.setRuntimeEnvironment();
        const [{ createServer }, { httpServerHandler }, mongooseModule] = await Promise.all([
          import('node:http'), import('cloudflare:node'), import('mongoose')
        ]);
        const mongoose = mongooseModule.default || mongooseModule;
        assertWorkersMongooseVersion(mongoose.version);

        const [appModule, notificationServiceModule] = await Promise.all([
          import('../server/app.js'), import('../server/services/notificationService.js')
        ]);
        const app = appModule.default || appModule;
        const notificationService = notificationServiceModule.default || notificationServiceModule;
        notificationService.setBroadcaster(async (userId, notification) => {
          if (!this.env.NOTIFICATION_HUB) throw new Error('NOTIFICATION_HUB binding is not configured');
          const hubId = this.env.NOTIFICATION_HUB.idFromName(String(userId));
          return this.env.NOTIFICATION_HUB.get(hubId).broadcast(notification);
        });

        const server = createServer(app);
        server.listen(8787);
        return { handler: httpServerHandler(server), mongoose };
      })().catch(error => {
        this.runtimePromise = null;
        throw error;
      });
    }
    return this.runtimePromise;
  }

  async fetch(request) {
    if (!this.env.MONGO_URI) {
      return Response.json({ success: false, code: 'MONGO_URI_MISSING' }, { status: 503 });
    }
    try {
      const runtime = await this.initialize();
      if (runtime.mongoose.connection.readyState !== 1) {
        if (!this.connectPromise) {
          this.connectPromise = runtime.mongoose.connect(this.env.MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 5,
            minPoolSize: 0
          }).catch(error => {
            this.connectPromise = null;
            throw error;
          });
        }
        await this.connectPromise;
      }
      return await runtime.handler(request);
    } catch (error) {
      console.error('[safaribet-backend-runtime]', error?.stack || error?.message || error);
      return Response.json({ success: false, code: 'BACKEND_UNAVAILABLE' }, {
        status: 503,
        headers: { 'cache-control': 'no-store' }
      });
    }
  }
}
