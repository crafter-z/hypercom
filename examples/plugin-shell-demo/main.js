/*
 * HyperCom shell.execute example.
 *
 * This example only runs after a user clicks the declared sidebar button;
 * it never starts a local process during Worker startup.
 */

self.plugin.on('ui.buttonClick', async function (payload) {
  if (!payload || payload.buttonId !== 'show-git-version') return;
  try {
    var result = await self.plugin.api['shell.execute']({
      program: 'git',
      args: ['--version'],
    });
    var stdout = result.stdout || '(empty)';
    var stderr = result.stderr || '(empty)';
    await self.plugin.api['ui.panel.append']({
      text: '[stdout]\n' + stdout + '\n[stderr]\n' + stderr + '\n[exit] ' + result.exitCode + '\n',
    });
  } catch (error) {
    await self.plugin.api['ui.panel.append']({
      text: '[shell demo] execution failed: ' + (error && error.message ? error.message : error) + '\n',
    });
  }
});
