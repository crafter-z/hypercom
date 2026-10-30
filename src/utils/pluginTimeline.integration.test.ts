import { afterEach, describe, expect, it, vi } from 'vitest';
import sdkSource from '../../src-tauri/src/plugin/view_runtime/sdk.js?raw';
import { PluginTimeline } from './pluginTimeline';
import { timelineCoordinator } from './timeline/coordinator';
import type { PluginTimelineResult, PluginViewHostMessage } from '../types/pluginViews';

let host: PluginTimeline | undefined;
afterEach(() => { host?.dispose(); host = undefined; timelineCoordinator.getSnapshot().groups.forEach(g => timelineCoordinator.deleteGroup(g.id)); vi.useRealTimers(); });

describe('production SDK to host coordinator JSON timeline roundtrip', () => {
  it('drives and follows without a Worker while a normal state callback is stalled', async () => {
    vi.useFakeTimers();
    const context = { pluginId: 'com.example.roundtrip', installGeneration: 'install', viewId: 'page', tabId: 'page-tab', placement: 'workspace-tab' as const, boundPortId: null, portMode: null, tabSessionId: 'session', viewInstanceId: 'instance', workerEpoch: 0, streamEpoch: 0 };
    const page = { ipc: { postMessage: (encoded: string) => { const message = JSON.parse(encoded); if (message.type === 'timeline') host!.receive(message.payload); } } } as unknown as {
      view: { timeline: { register(options: object): { beginNavigation(intent: string): { end(anchor: { timeMs: number; recordKey?: string }): void } } }; onState(cb: () => unknown): void; send(type: string, payload: unknown): void };
      __hypercomViewDocumentStart(id: string): void;
      __hypercomViewDispatch(message: PluginViewHostMessage): void;
    };
    const sent: PluginViewHostMessage[] = [];
    host = new PluginTimeline({ binding: context, declaration: { id: 'page', label: 'Page', entry: 'index.html', mode: 'trusted-web', worker: false, styles: [], assets: [], modes: ['trx'], input: 'none', placements: ['workspace-tab'], portBinding: 'none', restoreOnStartup: true }, documentId: 'document', send: async message => { const decoded = JSON.parse(JSON.stringify(message)) as PluginViewHostMessage; sent.push(decoded); page.__hypercomViewDispatch(decoded); } });
    host.setVisible(true);
    const source = sdkSource.replace('__HOST_TRUSTED_WEB__', 'true').replace('__HOST_HAS_WORKER__', 'false').replace('__HOST_VIEW_CONTEXT__', JSON.stringify(context));
    new Function('globalThis', 'addEventListener', source)(page, () => {});
    page.__hypercomViewDocumentStart('document');
    page.__hypercomViewDispatch({ type: 'init', documentId: 'document', context, environment: { theme: 'dark', language: 'en', fontFamily: 'system-ui', fontSize: 14, zoomPercent: 100, visible: true, focused: true, portStatus: null } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    page.view.onState(() => new Promise(() => {})); page.__hypercomViewDispatch({ type: 'state', documentId: 'document', revision: 1, snapshot: {} });
    let finish!: (result: PluginTimelineResult) => void;
    const applied: number[] = [];
    const timeline = page.view.timeline.register({ version: 1, clock: { kind: 'custom', id: 'device' }, capabilities: { preview: 'bounded', canDrive: true }, onSeek: async ({ timeMs }: { timeMs: number }) => { applied.push(timeMs); return new Promise<PluginTimelineResult>(resolve => { finish = resolve; }); } });
    const groupId = timelineCoordinator.createGroup({ name: 'Roundtrip', memberSlots: ['page-tab'] });
    timelineCoordinator.seek(groupId, 5000); await vi.advanceTimersByTimeAsync(1);
    expect(applied).toEqual([5000]); expect(sent.find(m => m.type === 'timeline-seek')?.timeline).toMatchObject({ timeMs: 5000, sourceGeneration: 0, phase: 'commit' });
    expect(timelineCoordinator.groupForSlot('page-tab')?.members[0].actualTimeMs).toBeUndefined();
    finish({ status: 'nearest', actualTimeMs: 4500, recordKey: 'record-45' });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(timelineCoordinator.groupForSlot('page-tab')?.members[0]).toMatchObject({ status: 'nearest', actualTimeMs: 4500, deltaMs: -500 });
    const navigation = timeline.beginNavigation('align'); navigation.end({ timeMs: 6000, recordKey: 'record-60' });
    expect(timelineCoordinator.groupForSlot('page-tab')?.committedAnchor).toEqual({ timeMs: 6000, recordKey: 'record-60' });
    expect(() => page.view.send('ordinary-worker-message', null)).toThrow('no Worker');
  });
});
