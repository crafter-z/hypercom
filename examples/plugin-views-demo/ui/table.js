const root = document.getElementById('plugin-root');
const title = document.createElement('h2'); title.textContent = 'Sensor table';
const toolbar = document.createElement('div'); toolbar.className = 'toolbar';
const filter = document.createElement('input'); filter.placeholder = 'Filter device';
const sort = document.createElement('select');
for (const [value, label] of [['at', 'Newest first'], ['temperature', 'Temperature descending'], ['voltage', 'Voltage descending']]) {
  const option = document.createElement('option'); option.value = value; option.textContent = label; sort.append(option);
}
const clear = document.createElement('button'); clear.textContent = 'Clear'; clear.onclick = () => view.send('clear', null);
const wave = document.createElement('button'); wave.textContent = 'Open waveform tab'; wave.onclick = () => view.send('open-wave', null);
toolbar.append(filter, sort, clear, wave);
const status = document.createElement('p'); status.className = 'status';
const scroll = document.createElement('div'); scroll.className = 'table-scroll';
const table = document.createElement('table');
const head = document.createElement('thead'); const headers = document.createElement('tr');
for (const name of ['Time', 'Device', 'Temperature °C', 'Voltage V', 'Timeline']) { const th = document.createElement('th'); th.textContent = name; headers.append(th); }
head.append(headers); const body = document.createElement('tbody'); table.append(head, body); scroll.append(table);
root.append(title, toolbar, status, scroll);
let model = { rows: [], gaps: 0, rejected: 0, status: 'waiting' };
let selectedKey = null;
const visibleRows = () => model.rows.filter(row => row.device.toLowerCase().includes(filter.value.toLowerCase())).slice().sort((a, b) => b[sort.value] - a[sort.value]);
// This sample retains only 200 records, so scanning/rendering is explicitly
// bounded. Large plugins must use their own visible-time index or commit-only.
const timeline = view.timeline?.register({
  version: 1, clock: { kind: 'bound-input' }, capabilities: { preview: 'bounded', canDrive: true },
  async onSeek({ timeMs, signal }) {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) { timeline?.setAvailability({ available: false }); return { status: 'held' }; }
    const rows = visibleRows().filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at || Number(a.id) - Number(b.id));
    if (!rows.length) return { status: model.rows.some(row => Number.isFinite(row.at)) ? 'filtered' : 'no-time' };
    const row = rows.filter(item => item.at <= timeMs).at(-1) || rows[0];
    if (signal.aborted) return { status: 'held' };
    selectedKey = row.id; render();
    [...body.children].find(element => element.dataset.recordKey === row.id)?.scrollIntoView({ block: 'center' });
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (signal.aborted) return { status: 'held' };
    return { status: timeMs < rows[0].at ? 'before-range' : timeMs > rows.at(-1).at ? 'after-range' : row.at === timeMs ? 'exact' : 'nearest', actualTimeMs: row.at, recordKey: row.id };
  },
});
function render() {
  status.textContent = `${model.portId || ''} · ${model.status} · ${model.rows.length}/200 records · gaps ${model.gaps} · rejected ${model.rejected}`;
  const rows = visibleRows();
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr'); tr.dataset.recordKey = row.id;
    if (row.temperature >= model.threshold) tr.className = 'alert';
    if (row.id === selectedKey) tr.style.outline = '2px solid currentColor';
    for (const text of [Number.isFinite(row.at) ? new Date(row.at).toLocaleTimeString() : '—', row.device, row.temperature.toFixed(2), row.voltage.toFixed(3)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    const action = document.createElement('td'); const align = document.createElement('button'); align.textContent = 'Align by this time';
    align.disabled = !timeline || sort.value !== 'at' || !Number.isFinite(row.at);
    align.onclick = () => { const navigation = timeline.beginNavigation('align'); navigation.end({ timeMs: row.at, recordKey: row.id }); };
    action.append(align); tr.append(action); fragment.append(tr);
  }
  body.replaceChildren(fragment);
}
function updateSummary() {
  const times = visibleRows().map(row => row.at).filter(Number.isFinite);
  const selection = document.getSelection();
  timeline?.setAvailability({ available: !selection || selection.isCollapsed, ...(times.length ? { range: { startMs: Math.min(...times), endMs: Math.max(...times) } } : {}) });
  timeline?.updateCapabilities({ preview: 'bounded', canDrive: sort.value === 'at' });
}
document.addEventListener('selectionchange', updateSummary);
filter.oninput = () => { render(); updateSummary(); }; sort.onchange = () => { render(); updateSummary(); };
view.onState(snapshot => { model = snapshot; render(); updateSummary(); });
view.onEnvironment(environment => { document.documentElement.dataset.theme = environment.theme; });
addEventListener('pagehide', () => timeline?.dispose(), { once: true });
