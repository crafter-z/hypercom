import { afterEach, describe, expect, it } from 'vitest';
import { acquirePluginDialog, resetPluginDialogBudgetForTest } from './pluginDialogBudget';

afterEach(() => resetPluginDialogBudgetForTest());

describe('plugin dialog budget', () => {
  it('bounds live dialogs across Worker generations and releases on termination', () => {
    const releases = Array.from({ length: 8 }, () => acquirePluginDialog('com.example.dialog'));
    expect(() => acquirePluginDialog('com.example.dialog')).toThrow('dialog capacity exceeded');
    releases[0]();
    const releaseReplacement = acquirePluginDialog('com.example.dialog');
    releaseReplacement();
    releases.slice(1).forEach((release) => release());
  });
});
