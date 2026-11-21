const root = document.getElementById('plugin-root');
const title = document.createElement('h2'); title.textContent = 'Sensor settings';
const description = document.createElement('p'); description.textContent = 'This tool tab has no bound port. Saving changes only plugin-private settings.';
const label = document.createElement('label'); label.textContent = 'Temperature alert threshold °C ';
const input = document.createElement('input'); input.type = 'number'; input.min = '-100'; input.max = '200'; input.step = '0.1'; label.append(input);
const save = document.createElement('button'); save.textContent = 'Save';
const status = document.createElement('p'); status.className = 'status';
const preview = document.createElement('p');
const outcome = document.createElement('p'); outcome.setAttribute('role', 'status');
input.oninput = () => {
  if (Number.isFinite(input.valueAsNumber)) view.preview?.('preview-threshold', { threshold: input.valueAsNumber });
};
save.onclick = async () => {
  const threshold = input.valueAsNumber;
  if (!Number.isFinite(threshold)) return;
  if (!view.sendAction) { view.send('save-threshold', { threshold }); return; }
  save.disabled = true;
  try {
    const result = await view.sendAction('save-threshold', { threshold });
    outcome.textContent = {
      accepted: 'Save request accepted. The saved value updates after storage completes.',
      busy: 'The settings view is busy. Nothing was queued; you can try again.',
      unavailable: 'The settings Worker is unavailable. Nothing was queued.',
      unknown: 'Save request was not confirmed. Check the saved value before trying again.',
    }[result.status];
  } catch (error) { outcome.textContent = String(error); }
  finally { save.disabled = false; }
};
root.append(title, description, label, save, outcome, status, preview);
let initialized = false;
view.onState(snapshot => {
  if (!initialized) { initialized = true; input.value = String(snapshot.threshold); }
  status.textContent = `Saved threshold: ${snapshot.threshold} °C`;
  preview.textContent = Number.isFinite(snapshot.previewThreshold) ? `Preview only: ${snapshot.previewThreshold} °C` : '';
});
view.onEnvironment(environment => { document.documentElement.dataset.theme = environment.theme; });
