// Diagnostics channel compatibility probe.
//
// Runs the same battery everywhere Node's module surface is claimed and
// returns the results. No network. Two setTimeout uses: one to give
// deferred error surfacing turns, one to bound a callback wait. An
// optional process.on('uncaughtException') listener is guarded, since not
// every runtime's process polyfill supports it.
//
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
    // A second publish proves the unsubscription actually took effect.
    ch.publish({ v: 2 });
    const after = diagnostics_channel.hasSubscribers('p:basic');
    rec('string-publish',
      before === true && seen.length === 1 && seen[0][0] && seen[0][0].v === 1
        && seen[0][1] === 'p:basic' && unsub === true && after === false,
      'fired: ' + seen.length + ' (post-unsubscribe publish also fired: ' + (seen.length > 1)
        + '), unsub returns: ' + unsub + ', has after: ' + after);
  });

  await guard('symbol-names', async () => {
    const s = Symbol('p:sym');
    const seen = [];
    const fn = (m, n) => seen.push([m, n === s]);
    diagnostics_channel.subscribe(s, fn);
    const has = diagnostics_channel.hasSubscribers(s);
    const ch = diagnostics_channel.channel(s);
    ch.publish('x');
    diagnostics_channel.unsubscribe(s, fn);
    ch.publish('y');
    rec('symbol-names',
      has === true && seen.length === 1 && seen[0][1] === true,
      'has: ' + has + ', fired: ' + seen.length + ' (post-unsubscribe publish also fired: '
        + (seen.length > 1) + '), name is the supplied symbol: ' + seen[0][1]
        + ', channel(): ' + typeof ch);
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
    const make = (name) => {
      const ch = diagnostics_channel.channel(name);
      const hits = [];
      const thrower = () => { throw new Error('boom'); };
      const second = () => hits.push(2);
      ch.subscribe(thrower);
      ch.subscribe(second);
      return { ch, hits, thrower, second };
    };
    // One subscriber error happens before any listener is registered, one
    // after, so the probe observes both delivery cases.
    const before = make('p:err-before');
    const after = make('p:err-after');

    let syncThrowBefore = false;
    try {
      before.ch.publish({});
    } catch {
      syncThrowBefore = true;
    }
    const secondRanBefore = before.hits.length > 0;

    const deferred = [];
    let handler = null;
    let listenerOk = false;
    const hasProcess = typeof process !== 'undefined' && typeof process.on === 'function';
    if (hasProcess) {
      try {
        handler = (e) => { deferred.push((e && e.message) || String(e)); };
        process.on('uncaughtException', handler);
        listenerOk = true;
      } catch {
        handler = null;
      }
    }

    let syncThrowAfter = false;
    try {
      after.ch.publish({});
    } catch {
      syncThrowAfter = true;
    }
    const secondRanAfter = after.hits.length > 0;

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
    for (const c of [before, after]) {
      c.ch.unsubscribe(c.thrower);
      c.ch.unsubscribe(c.second);
    }

    const threw = syncThrowBefore || syncThrowAfter;
    const dispatched = secondRanBefore && secondRanAfter;
    rec('subscriber-error',
      !threw && dispatched && listenerOk && deferred.length === 2,
      'publish threw synchronously: before=' + syncThrowBefore + ' after=' + syncThrowAfter
        + ', second subscriber ran: before=' + secondRanBefore + ' after=' + secondRanAfter
        + ', deferred uncaught delivered: ' + JSON.stringify(deferred)
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
    const ctxs = [];
    const ctx = { a: 1 };
    const handlers = {
      start(c) { events.push('start'); ctxs.push(c); },
      end(c) { events.push('end'); ctxs.push(c); },
      asyncStart(c) { events.push('asyncStart'); ctxs.push(c); },
      asyncEnd(c) { events.push('asyncEnd'); ctxs.push(c); },
      error(c) { events.push('error'); ctxs.push(c); },
    };
    tc.subscribe(handlers);
    const out = await tc.tracePromise(async (x) => ({ v: x + 1 }), ctx, null, 41);
    tc.unsubscribe(handlers);
    const sameCtx = ctxs.length === 4 && ctxs.every((c) => c === ctx);
    const resultAtEnd = ctxs[1] && ctxs[1].result;
    const resultAtAsyncEnd = ctxs[3] && ctxs[3].result;
    rec('trace-promise',
      out && out.v === 42
        && events.join(',') === 'start,end,asyncStart,asyncEnd'
        && sameCtx
        && !!(resultAtAsyncEnd && resultAtAsyncEnd.v === 42),
      'events: ' + events.join(',') + ', same ctx across events: ' + sameCtx
        + ', ctx.result at end (type): ' + typeof resultAtEnd
        + ', at asyncEnd: ' + (resultAtAsyncEnd && resultAtAsyncEnd.v)
        + ', out: ' + JSON.stringify(out));
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
      rejected && events.includes('error') && errMsg === 'boom',
      'events: ' + events.join(',') + ', rejected: ' + rejected + ', ctx.error: ' + errMsg);
  });

  await guard('trace-callback', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('trace-callback', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcc');
    const events = [];
    const ctxs = [];
    const ctx = { tag: 'cb' };
    const handlers = {
      start(c) { events.push('start'); ctxs.push(c); },
      end(c) { events.push('end'); ctxs.push(c); },
      asyncStart(c) { events.push('asyncStart'); ctxs.push(c); },
      asyncEnd(c) { events.push('asyncEnd'); ctxs.push(c); },
      error(c) { events.push('error'); ctxs.push(c); },
    };
    tc.subscribe(handlers);
    // Bounded: a traceCallback that never fires the callback becomes a
    // failed test, not a hung probe.
    await new Promise((resolve) => {
      const timer = setTimeout(() => { events.push('cb-timeout'); resolve(); }, 500);
      tc.traceCallback((a, cb) => { cb(null, a * 2); }, 1, ctx, null, 21,
        (err, res) => { clearTimeout(timer); events.push('cb:' + res); resolve(); });
    });
    tc.unsubscribe(handlers);
    const sameCtx = ctxs.length === 4 && ctxs.every((c) => c === ctx);
    rec('trace-callback',
      events.join(',') === 'start,asyncStart,cb:42,asyncEnd,end' && sameCtx,
      'events: ' + events.join(',') + ', same ctx across events: ' + sameCtx);
  });

  await guard('trace-sync', async () => {
    if (typeof diagnostics_channel.tracingChannel !== 'function') {
      rec('trace-sync', false, 'tracingChannel not exported');
      return;
    }
    const tc = diagnostics_channel.tracingChannel('p:tcs');
    const events = [];
    const ctxs = [];
    const handlers = {
      start(c) { events.push('start'); ctxs.push(c); },
      end(c) { events.push('end'); ctxs.push(c); },
      asyncStart(c) { events.push('asyncStart'); ctxs.push(c); },
      asyncEnd(c) { events.push('asyncEnd'); ctxs.push(c); },
      error(c) { events.push('error'); ctxs.push(c); },
    };
    tc.subscribe(handlers);
    if (typeof tc.traceSync !== 'function') {
      tc.unsubscribe(handlers);
      rec('trace-sync', false, 'traceSync missing');
      return;
    }
    const out = tc.traceSync(() => 7, { tag: 'sync' });
    tc.unsubscribe(handlers);
    const sameCtx = ctxs.length === 2 && ctxs.every((c) => c && c.tag === 'sync');
    rec('trace-sync',
      out === 7 && events.join(',') === 'start,end' && sameCtx,
      'events: ' + events.join(',') + ', out: ' + out + ', same ctx across events: ' + sameCtx);
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
    const outer = { tag: 'outer' };
    let startStore = null;
    let asyncStartStore = null;
    let afterStore = null;
    if (typeof tc.start.bindStore !== 'function'
      || typeof tc.asyncStart.bindStore !== 'function') {
      rec('tracingchannel-restore', false, 'subchannel bindStore missing');
      return;
    }
    tc.start.bindStore(als, (c) => { c.store = { tag: 'tc' }; return c.store; });
    tc.asyncStart.bindStore(als, (c) => c.store);
    const handlers = {
      start() { const s = als.getStore(); startStore = s && s.tag; },
      asyncStart() { const s = als.getStore(); asyncStartStore = s && s.tag; },
      end() {},
      asyncEnd() {},
      error() {},
    };
    tc.subscribe(handlers);
    // The trace runs inside an outer store. If the trace leaks its store
    // past completion, afterStore will not be the outer one.
    await als.run(outer, async () => {
      await tc.tracePromise(async () => 1, {});
      afterStore = als.getStore();
    });
    tc.unsubscribe(handlers);
    rec('tracingchannel-restore',
      startStore === 'tc' && asyncStartStore === 'tc' && afterStore === outer,
      'store inside start: ' + startStore + ', inside asyncStart: ' + asyncStartStore
        + ', store after trace: ' + (afterStore && afterStore.tag));
  });

  return T;
}
