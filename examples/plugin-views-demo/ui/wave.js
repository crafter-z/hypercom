const root = document.getElementById('plugin-root');
const title = document.createElement('h2'); title.textContent = 'Temperature waveform';
const status = document.createElement('p'); status.className = 'status';
const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 400; canvas.className = 'wave';
const scrub = document.createElement('input'); scrub.type = 'range'; scrub.step = '1'; scrub.disabled = true; scrub.setAttribute('aria-label', 'Navigate by collection time');
root.append(title, status, canvas, scrub);
let model = { rows: [], gaps: 0, status: 'waiting' }; let selectedTime = null; let navigation = null;
const timedRows = () => model.rows.filter(row => Number.isFinite(row.at));
function render() {
  status.textContent = `${model.portId || ''} · ${model.status} · ${model.rows.length}/200 samples · gaps ${model.gaps}${selectedTime === null ? '' : ` · ${new Date(selectedTime).toLocaleTimeString()}`}`;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const color = getComputedStyle(document.body).color;
  context.strokeStyle = color; context.fillStyle = color; context.font = '14px system-ui';
  const rows = timedRows();
  if (!rows.length) { context.fillText('Waiting for timestamped sensor frames or SIM heartbeat', 20, 40); return; }
  const min = Math.min(...rows.map(row => row.temperature)) - 1;
  const max = Math.max(...rows.map(row => row.temperature)) + 1;
  const start = Math.min(...rows.map(row => row.at)); const end = Math.max(...rows.map(row => row.at));
  const xAt = time => 75 + (time - start) / Math.max(1, end - start) * 900;
  context.fillText(`${max.toFixed(1)} °C`, 10, 20); context.fillText(`${min.toFixed(1)} °C`, 10, 385);
  context.fillText(new Date(start).toLocaleTimeString(), 75, 398);
  context.beginPath();
  rows.forEach((row, index) => {
    const x = xAt(row.at); // True collection time, not sample index.
    const y = 370 - (row.temperature - min) / (max - min) * 340;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.lineWidth = 2; context.stroke();
  if (selectedTime !== null) {
    const x = xAt(Math.max(start, Math.min(end, selectedTime)));
    context.setLineDash([5, 4]); context.beginPath(); context.moveTo(x, 25); context.lineTo(x, 375); context.stroke(); context.setLineDash([]);
  }
}
const timeline = view.timeline?.register({
  version: 1, clock: { kind: 'bound-input' }, capabilities: { preview: 'bounded', canDrive: true },
  async onSeek({ timeMs, signal }) {
    const rows = timedRows().slice().sort((a, b) => a.at - b.at || Number(a.id) - Number(b.id));
    if (!rows.length) return { status: 'no-time' };
    const row = rows.filter(item => item.at <= timeMs).at(-1) || rows[0];
    if (signal.aborted) return { status: 'held' };
    selectedTime = row.at; scrub.value = String(row.at); render();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (signal.aborted) return { status: 'held' };
    return { status: timeMs < rows[0].at ? 'before-range' : timeMs > rows.at(-1).at ? 'after-range' : row.at === timeMs ? 'exact' : 'nearest', actualTimeMs: row.at, recordKey: row.id };
  },
});
function finish() { if (navigation) { navigation.end({ timeMs: Number(scrub.value) }); navigation = null; } }
scrub.onpointerdown = () => { if (timeline && !scrub.disabled && !navigation) navigation = timeline.beginNavigation('scrub'); };
scrub.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) && timeline && !navigation) navigation = timeline.beginNavigation('keyboard'); };
scrub.oninput = () => {
  if (!navigation && timeline) navigation = timeline.beginNavigation('scrub');
  selectedTime = Number(scrub.value); render(); navigation?.update({ timeMs: selectedTime });
};
scrub.onchange = finish; scrub.onkeyup = finish;
for (const type of ['pointerup', 'pointercancel', 'mouseup', 'blur']) addEventListener(type, finish, true);
addEventListener('visibilitychange', () => { if (document.hidden) finish(); });
view.onState(snapshot => {
  model = snapshot; const times = timedRows().map(row => row.at);
  scrub.disabled = !times.length;
  if (times.length) { scrub.min = String(Math.min(...times)); scrub.max = String(Math.max(...times)); if (selectedTime === null) scrub.value = scrub.max; }
  timeline?.setAvailability({ available: true, ...(times.length ? { range: { startMs: Number(scrub.min), endMs: Number(scrub.max) } } : {}) });
  render();
});
view.onEnvironment(environment => { document.documentElement.dataset.theme = environment.theme; render(); });
addEventListener('pagehide', () => { navigation?.cancel(); timeline?.dispose(); }, { once: true });
