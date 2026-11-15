import { describe, expect, it, vi } from 'vitest';
import source from '../../examples/plugin-shell-demo/main.js?raw';
import manifestSource from '../../examples/plugin-shell-demo/manifest.json?raw';

function loadExample() {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const execute = vi.fn().mockResolvedValue({ exitCode: 7, stdout: 'example stdout', stderr: 'example stderr' });
  const append = vi.fn().mockResolvedValue(null);
  const scope = {
    plugin: {
      api: { 'shell.execute': execute, 'ui.panel.append': append },
      on: (type: string, handler: (payload: unknown) => Promise<void>) => handlers.set(type, handler),
    },
  };
  new Function('self', source)(scope);
  return { handlers, execute, append };
}

describe('installable shell example', () => {
  it('needs only the execute grant and waits for its button before running a command', async () => {
    const manifest = JSON.parse(manifestSource);
    expect(manifest.permissions).toEqual(['shell:execute']);
    expect(manifest.shell).toBeUndefined();
    const example = loadExample();
    expect(example.execute).not.toHaveBeenCalled();
    await example.handlers.get('ui.buttonClick')!({ buttonId: 'other' });
    expect(example.execute).not.toHaveBeenCalled();
    await example.handlers.get('ui.buttonClick')!({ buttonId: manifest.ui.buttons[0].id });
    expect(example.execute).toHaveBeenCalledExactlyOnceWith({ program: 'git', args: ['--version'] });
    const text = example.append.mock.calls.map(([args]) => args.text).join('');
    expect(text).toContain('example stdout');
    expect(text).toContain('example stderr');
    expect(text).toContain('7');
  });

  it('shows execution failures instead of leaving the click with an unhandled rejection', async () => {
    const example = loadExample();
    example.execute.mockRejectedValueOnce(new Error('not installed'));
    await example.handlers.get('ui.buttonClick')!({ buttonId: 'show-git-version' });
    expect(example.append).toHaveBeenCalledWith({ text: expect.stringContaining('not installed') });
  });
});
