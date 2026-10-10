const MAX_ROWS = 200;
let threshold = 30;
const sessions = new Map();

function checksum(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum ^= text.charCodeAt(i);
  return sum;
}
function parseLine(line) {
  const checked = line.match(/^S,([^,]+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\*([0-9a-f]{2})$/i);
  if (checked && checksum(line.slice(0, line.lastIndexOf('*'))) === Number.parseInt(checked[4], 16)) {
    return { device: checked[1], temperature: Number(checked[2]), voltage: Number(checked[3]), at: Date.now() };
  }
  const heartbeat = line.match(/^\[SIM\] Heartbeat #(\d+)$/);
  if (heartbeat) {
    const sequence = Number(heartbeat[1]);
    return { device: 'SIM', temperature: 25 + Math.sin(sequence / 10) * 8, voltage: 3.3 + Math.cos(sequence / 8) * 0.1, at: Date.now() };
  }
  return null;
}
function snapshot(session) {
  return { portId: session.view.context.boundPortId, rows: session.rows, gaps: session.gaps, rejected: session.rejected, threshold, status: session.status };
}

self.plugin.views.onOpen(async view => {
  if (view.context.viewId === 'settings') {
    const saved = await self.plugin.api['storage.get']({ key: 'threshold' });
    if (typeof saved === 'number' && Number.isFinite(saved)) threshold = saved;
    await view.publish({ threshold });
    view.onMessage(async message => {
      if (message.type !== 'save-threshold' || typeof message.payload?.threshold !== 'number' || !Number.isFinite(message.payload.threshold)) return;
      const value = Math.max(-100, Math.min(200, message.payload.threshold));
      await self.plugin.api['storage.set']({ key: 'threshold', value });
      threshold = value;
      await view.publish({ threshold });
    });
    return;
  }
  const session = { view, decoder: new TextDecoder('utf-8'), pending: '', rows: [], gaps: 0, rejected: 0, status: 'connected' };
  sessions.set(view.context.viewInstanceId, session);
  view.onDiscontinuity(() => { session.decoder = new TextDecoder('utf-8'); session.pending = ''; session.gaps++; });
  view.onStatus(async status => { session.status = status.status; await view.publish(snapshot(session)); });
  view.onMessage(async message => {
    if (message.type === 'clear') { session.rows = []; await view.publish(snapshot(session)); }
    if (message.type === 'open-wave') await self.plugin.tabs.open({ viewId: 'wave', portId: view.context.boundPortId, instanceKey: 'live', activation: 'background' });
  });
  view.onInput(async batch => {
    for (const chunk of batch) {
      session.pending += session.decoder.decode(chunk.bytes, { stream: true });
      if (session.pending.length > 8192) { session.pending = ''; session.rejected++; session.decoder = new TextDecoder('utf-8'); continue; }
      const lines = session.pending.split(/\r?\n/);
      session.pending = lines.pop();
      for (const line of lines) {
        const row = parseLine(line);
        if (!row) { if (line) session.rejected++; continue; }
        session.rows.push(row);
        if (session.rows.length > MAX_ROWS) session.rows.shift();
      }
    }
    await view.publish(snapshot(session));
  });
  await view.publish(snapshot(session));
});
self.plugin.views.onClose(({ view }) => sessions.delete(view.context.viewInstanceId));
self.plugin.on('ui.buttonClick', async event => {
  if (event.buttonId === 'open-settings') {
    await self.plugin.tabs.open({ viewId: 'settings', instanceKey: 'settings', activation: 'foreground', actionToken: event.actionToken });
  } else if (event.context?.portId) {
    await self.plugin.tabs.open({ viewId: event.buttonId === 'open-wave' ? 'wave' : 'table', portId: event.context.portId, instanceKey: 'live', activation: 'foreground', actionToken: event.actionToken });
  }
});
