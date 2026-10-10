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
for (const name of ['Time', 'Device', 'Temperature °C', 'Voltage V']) { const th = document.createElement('th'); th.textContent = name; headers.append(th); }
head.append(headers); const body = document.createElement('tbody'); table.append(head, body); scroll.append(table);
root.append(title, toolbar, status, scroll);
let model = { rows: [], gaps: 0, rejected: 0, status: 'waiting' };
function render() {
  status.textContent = `${model.portId || ''} · ${model.status} · ${model.rows.length}/200 records · gaps ${model.gaps} · rejected ${model.rejected}`;
  const rows = model.rows.filter(row => row.device.toLowerCase().includes(filter.value.toLowerCase())).slice().sort((a, b) => b[sort.value] - a[sort.value]);
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.temperature >= model.threshold) tr.className = 'alert';
    for (const text of [new Date(row.at).toLocaleTimeString(), row.device, row.temperature.toFixed(2), row.voltage.toFixed(3)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
}
filter.oninput = render; sort.onchange = render;
view.onState(snapshot => { model = snapshot; render(); });
view.onEnvironment(environment => { document.documentElement.dataset.theme = environment.theme; });
