import { expect, it } from 'vitest';
import { previewPortToolCommand } from './tool';

it.each([
  ['COM5', '5'],
  ['cOm12', '12'],
  ['COM', 'COM'],
  ['COM5-extra', 'COM5-extra'],
  ['/dev/ttyUSB0', '/dev/ttyUSB0'],
  ['/dev/tty$&', '/dev/tty$&'],
])('previews %s as %s in every placeholder', (portId, renderedPort) => {
  expect(previewPortToolCommand('flasher --port {port} --log={port}.log', portId))
    .toBe(`flasher --port ${renderedPort} --log=${renderedPort}.log`);
});

it('allows explicitly including the COM prefix', () => {
  expect(previewPortToolCommand('flasher COM{port}', 'COM5')).toBe('flasher COM5');
});
