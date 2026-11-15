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

  async ensureConnected(runtime) {
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
  }

  // Background work that the Express process normally does with timers (server/engine/scheduler.js), run from the
  // every-minute Cron Trigger: poll live games (so a game is SEEN live and its end can be confirmed), then settle bets.
  // One tick lasts ~50s and polls live every 10s, like the original; a second tick never overlaps a running one.
  async cronTick() {
    if (this.tickRunning && Date.now() - this.tickRunning < 3 * 60000) return { skipped: true };
    this.tickRunning = Date.now();
    const out = { live: 0, settle: 0, errors: [] };
    try {
      await this.initialize();
      // The server modules are CommonJS: the functions live on module.exports (= the namespace's default).
      const load = async path => { const m = await import(path); return m.default || m; };
      const { updateLive } = await load('../server/engine/apifootball.js');
      const { runSettlement } = await load('../server/engine/settlementEngine.js');
      const { settleJackpots } = await load('../server/engine/jackpotSettlement.js');
      const started = Date.now();
      const minute = new Date().getUTCMinutes();
      let i = 0;
      while (Date.now() - started < 50000) {
        try { await updateLive(); out.live++; } catch (e) { out.errors.push('live: ' + e.message); }
        if (i % 2 === 1) { try { await runSettlement(false); out.settle++; } catch (e) { out.errors.push('settle: ' + e.message); } }
        i++;
        const wait = 10000 - ((Date.now() - started) % 10000);
        if (Date.now() - started + wait >= 50000) break;
        await new Promise(r => setTimeout(r, wait));
      }
      // slower safety-net pass (provider snapshot) + jackpots every 5 minutes, as in scheduler.js
      if (minute % 5 === 0) {
        try { await runSettlement(true); } catch (e) { out.errors.push('settle-full: ' + e.message); }
        try { await settleJackpots(); } catch (e) { out.errors.push('jackpots: ' + e.message); }
      }
    } catch (e) {
      out.errors.push(e && e.message);
    } finally {
      this.tickRunning = 0;
    }
    return out;
  }

  async fetch(request) {
    if (!this.env.MONGO_URI) {
      return Response.json({ success: false, code: 'MONGO_URI_MISSING' }, { status: 503 });
    }
    try {
      const runtime = await this.initialize();
      await this.ensureConnected(runtime);
      if (new URL(request.url).pathname === '/__cron/tick') {
        return Response.json(await this.cronTick(), { headers: { 'cache-control': 'no-store' } });
      }
      return await runtime.handler.fetch(request);
    } catch (error) {
      console.error('[safaribet-backend-runtime]', error?.stack || error?.message || error);
      return Response.json({ success: false, code: 'BACKEND_UNAVAILABLE' }, {
        status: 503,
        headers: { 'cache-control': 'no-store' }
      });
    }
  }
}
