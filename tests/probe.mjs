// Diagnostics channel compatibility probe.
//
// Pure module: no process, no network. Runs the same battery
// everywhere Node's module surface is claimed, and returns the results.
// Uses setTimeout once, to let deferred error surfacing happen.
// Entry points: cli.mjs (Node, Bun, Deno) and worker/index.mjs (Workers).

import diagnostics_channel from 'node:diagnostics_channel';
import { AsyncLocalStorage } from 'node:async_hooks';

export async function run() {
  const T = [];
  const rec = (id, ok, note) => T.push({ id, ok: !!ok, note: note == null ? '' : String(note) });
  const guard = async (id, fn) => {
    try {
      await fn();
    } catch (e) {
      rec(id, false, 'threw: ' + ((e && e.message) || e));
    }
  };

  await guard('module-surface', async () => {
    const keys = Object.keys(diagnostics_channel).sort().join(',');
    const ok = ['channel', 'hasSubscribers', 'subscribe', 'unsubscribe']
      .every((k) => typeof diagnostics_channel[k] === 'function');
    rec('module-surface', ok, 'keys: ' + keys);
  });

  await guard('channel-singleton', async () => {
    const a = diagnostics_channel.channel('p:singleton');
    const b = diagnostics_channel.channel('p:singleton');
    const checks = {
      same: a === b,
      name: a.name === 'p:singleton',
      subscribe: typeof a.subscribe === 'function',
      unsubscribe: typeof a.unsubscribe === 'function',
      publish: typeof a.publish === 'function',
    };
    rec('channel-singleton', Object.values(checks).every(Boolean),
      JSON.stringify(checks) + ', name value: ' + typeof a.name
      + ', hasSubscribers type: ' + typeof a.hasSubscribers);
  });

  await guard('string-publish', async () => {
    const seen = [];
    const fn = (m, n) => seen.push([m, n]);
    const ch = diagnostics_channel.channel('p:basic');
    diagnostics_channel.subscribe('p:basic', fn);
    const before = diagnostics_channel.hasSubscribers('p:basic');
    ch.publish({ v: 1 });
    const unsub = diagnostics_channel.unsubscribe('p:basic', fn);
    const after = diagnostics_channel.hasSubscribers('p:basic');
    rec('string-publish',
      before === true && seen.length === 1 && seen[0][0] && seen[0][0].v === 1
        && seen[0][1] === 'p:basic' && unsub === true && after === false,
      'fired: ' + seen.length + ', unsub returns: ' + unsub + ', has after: ' + after);
  });

  await guard('symbol-names', async () => {
    const s = Symbol('p:sym');
    const seen = [];
    const fn = (m, n) => seen.push(n === s);
    diagnostics_channel.subscribe(s, fn);
    const has = diagnostics_channel.hasSubscribers(s);
    const ch = diagnostics_channel.channel(s);
    ch.publish('x');
    diagnostics_channel.unsubscribe(s, fn);
    rec('symbol-names', has === true && seen.length === 1,
      'has: ' + has + ', fired: ' + seen.length + ', channel(): ' + typeof ch);
  });

  await guard('subscriber-order', async () => {
    const order = [];
    const ch = diagnostics_channel.channel('p:order');
    const f1 = () => order.push(1);
    const f2 = () => order.push(2);
    ch.subscribe(f1);
    ch.subscribe(f2);
    ch.publish({});
    ch.unsubscribe(f1);
    ch.unsubscribe(f2);
    rec('subscriber-order', order.join('') === '12', 'order: ' + (order.join(',') || 'none'));
  });

  await guard('subscriber-error', async () => {
    const ch = diagnostics_channel.channel('p:err');
    const hits = [];
    const f1 = () => { throw new Error('boom'); };
    const f2 = () => hits.push(2);
    ch.subscribe(f1);
    ch.subscribe(f2);
    let syncThrow = false;
    try {
      ch.publish({});
    } catch {
      syncThrow = true;
    }
    const secondRan = hits.length > 0;

    // The error may not propagate to the publish caller. Give the loop a
    // turn to surface it wherever this runtime puts it.
    let deferred = null;
    let handler = null;
    let listenerOk = false;
    const hasProcess = typeof process !== 'undefined' && typeof process.on === 'function';
    if (hasProcess) {
      try {
        handler = (e) => { deferred = (e && e.message) || String(e); };
        process.on('uncaughtException', handler);
        listenerOk = true;
      } catch {
        handler = null;
      }
    }
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    if (listenerOk && handler) {
      try {
        process.removeListener('uncaughtException', handler);
      } catch {
        // leave it; the listener is a no-op from here on
      }
    }
    ch.unsubscribe(f1);
    ch.unsubscribe(f2);
    rec('subscriber-error',
      secondRan && !syncThrow,
      'publish threw synchronously: ' + syncThrow + ', second subscriber ran: ' + secondRan
        + ', deferred uncaught: ' + (deferred || 'not observed')
        + (hasProcess && !listenerOk ? ' (uncaughtException listener unsupported)' : ''));
  });

  await guard('tracingchannel-surface', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('tracingchannel-surface', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tc');
    const names = ['start', 'end', 'asyncStart', 'asyncEnd', 'error']
      .map((k) => k + '=' + (tc[k] && tc[k].name));
    const ok = ['start', 'end', 'asyncStart', 'asyncEnd', 'error']
        .every((k) => tc[k] && typeof tc[k].subscribe === 'function' && typeof tc[k].publish === 'function')
      && typeof tc.subscribe === 'function'
      && typeof tc.unsubscribe === 'function';
    const helpers = ['traceSync', 'tracePromise', 'traceCallback']
      .map((k) => k + '=' + typeof tc[k]).join(',');
    rec('tracingchannel-surface', ok, names.join(' | ') + ' | ' + helpers);
  });

  await guard('trace-promise', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('trace-promise', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcp');
    const events = [];
    const ctx = { a: 1 };
    let ctxSeen = null;
    const handlers = {
      start(c) { events.push('start'); ctxSeen = c; },
      end(c) { events.push('end:' + (c.result && c.result.v)); },
      asyncStart(c) { events.push('asyncStart'); },
      asyncEnd(c) { events.push('asyncEnd'); },
      error(c) { events.push('error'); },
    };
    tc.subscribe(handlers);
    const out = await tc.tracePromise(async (x) => ({ v: x + 1 }), ctx, null, 41);
    tc.unsubscribe(handlers);
    const allFired = ['start', 'asyncStart', 'asyncEnd'].every((e) => events.some((x) => x.startsWith(e)));
    rec('trace-promise',
      out && out.v === 42 && allFired && ctxSeen === ctx,
      'events: ' + events.join(',') + ', ctx identity: ' + (ctxSeen === ctx) + ', out: ' + JSON.stringify(out));
  });

  await guard('trace-promise-reject', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('trace-promise-reject', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcr');
    const events = [];
    let errMsg = '';
    const handlers = {
      start() { events.push('start'); },
      end() { events.push('end'); },
      asyncStart() { events.push('asyncStart'); },
      asyncEnd() { events.push('asyncEnd'); },
      error(c) { events.push('error'); errMsg = (c && c.error && c.error.message) || ''; },
    };
    tc.subscribe(handlers);
    let rejected = false;
    try {
      await tc.tracePromise(async () => { throw new Error('boom'); }, {});
    } catch {
      rejected = true;
    }
    tc.unsubscribe(handlers);
    rec('trace-promise-reject',
      rejected && events.includes('error'),
      'events: ' + events.join(',') + ', rejected: ' + rejected + ', ctx.error: ' + errMsg);
  });

  await guard('trace-callback', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('trace-callback', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcc');
    const events = [];
    const handlers = {
      start() { events.push('start'); },
      end() { events.push('end'); },
      asyncStart() { events.push('asyncStart'); },
      asyncEnd() { events.push('asyncEnd'); },
      error() { events.push('error'); },
    };
    tc.subscribe(handlers);
    await new Promise((resolve) => {
      tc.traceCallback((a, cb) => { cb(null, a * 2); }, 1, { tag: 'cb' }, null, 21,
        (err, res) => { events.push('cb:' + res); resolve(); });
    });
    tc.unsubscribe(handlers);
    rec('trace-callback',
      events.includes('cb:42') && events.includes('start'),
      'events: ' + events.join(','));
  });

  await guard('trace-sync', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('trace-sync', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcs');
    const events = [];
    const handlers = {
      start() { events.push('start'); },
      end() { events.push('end'); },
      asyncStart() { events.push('asyncStart'); },
      asyncEnd() { events.push('asyncEnd'); },
      error() { events.push('error'); },
    };
    tc.subscribe(handlers);
    if (typeof tc.traceSync !== 'function') {
      tc.unsubscribe(handlers);
      rec('trace-sync', false, 'traceSync missing');
      return;
    }
    const out = tc.traceSync(() => 7, { tag: 'sync' });
    tc.unsubscribe(handlers);
    rec('trace-sync',
      out === 7 && events.includes('start') && events.includes('end'),
      'events: ' + events.join(',') + ', out: ' + out);
  });

  await guard('bind-store-runstores', async () => {
    if (typeof diagnostics_channel.channel !== 'function'
      || typeof AsyncLocalStorage !== 'function') {
      rec('bind-store-runstores', false, 'channel or AsyncLocalStorage missing');
      return;
    }
    const ch = diagnostics_channel.channel('p:store');
    if (typeof ch.bindStore !== 'function' || typeof ch.runStores !== 'function') {
      rec('bind-store-runstores', false, 'bindStore/runStores missing: '
        + typeof ch.bindStore + '/' + typeof ch.runStores);
      return;
    }
    const als = new AsyncLocalStorage();
    let inside = null;
    ch.bindStore(als, (msg) => ({ from: msg }));
    ch.runStores({ tag: 'bs' }, () => { inside = als.getStore(); });
    const after = als.getStore();
    rec('bind-store-runstores',
      !!inside && !!inside.from && inside.from.tag === 'bs' && after === undefined,
      'inside: ' + JSON.stringify(inside) + ', after: ' + after);
  });

  await guard('tracingchannel-restore', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function'
      || typeof AsyncLocalStorage !== 'function') {
      rec('tracingchannel-restore', false, 'tracingChannel or AsyncLocalStorage missing');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcs2');
    const als = new AsyncLocalStorage();
    let startStore = null;
    let asyncStartStore = null;
    if (typeof tc.start.bindStore !== 'function'
      || typeof tc.asyncStart.bindStore !== 'function') {
      rec('tracingchannel-restore', false, 'subchannel bindStore missing');
      return;
    }
    tc.start.bindStore(als, (ctx) => { ctx.store = { tag: 'tc' }; return ctx.store; });
    tc.asyncStart.bindStore(als, (ctx) => ctx.store);
    const handlers = {
      start() { const s = als.getStore(); startStore = s && s.tag; },
      asyncStart() { const s = als.getStore(); asyncStartStore = s && s.tag; },
      end() {},
      asyncEnd() {},
      error() {},
    };
    tc.subscribe(handlers);
    await tc.tracePromise(async () => 1, {});
    tc.unsubscribe(handlers);
    rec('tracingchannel-restore',
      startStore === 'tc' && asyncStartStore === 'tc',
      'start store: ' + startStore + ', asyncStart store: ' + asyncStartStore);
  });

  return T;
}
