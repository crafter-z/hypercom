const root = document.getElementById('plugin-root');
const title = document.createElement('h2'); title.textContent = 'Temperature waveform';
const status = document.createElement('p'); status.className = 'status';
const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 400; canvas.className = 'wave';
root.append(title, status, canvas);
view.onState(model => {
  status.textContent = `${model.portId} · ${model.status} · ${model.rows.length}/200 samples · gaps ${model.gaps}`;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const color = getComputedStyle(document.body).color;
  context.strokeStyle = color; context.fillStyle = color; context.font = '14px system-ui';
  const rows = model.rows;
  if (!rows.length) { context.fillText('Waiting for sensor frames or SIM heartbeat', 20, 40); return; }
  const min = Math.min(...rows.map(row => row.temperature)) - 1;
  const max = Math.max(...rows.map(row => row.temperature)) + 1;
  context.fillText(`${max.toFixed(1)} °C`, 10, 20); context.fillText(`${min.toFixed(1)} °C`, 10, 385);
  context.beginPath();
  rows.forEach((row, index) => {
    const x = 75 + index / Math.max(1, rows.length - 1) * 900;
    const y = 370 - (row.temperature - min) / (max - min) * 340;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.lineWidth = 2; context.stroke();
});
view.onEnvironment(environment => { document.documentElement.dataset.theme = environment.theme; });
