import { useCallback, useEffect, useRef, useState } from 'react';
import { fileService, type ReplayPickedSources } from '../../../services/file';
import { importReplaySources, openReplaySession, type ReplaySessionDescription, type ReplayTrackPlan } from '../../../utils/replay/replayRuntime';

/** Native-authorized independent import. Never touches RX, traffic or a port buffer. */
export function useLogReplay(replacing?: ReplaySessionDescription) {
  const [picked, setPicked] = useState<ReplayPickedSources | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const selected = useRef<ReplayPickedSources | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const pickerPending = useRef(false);
  const cancelImport = useCallback(() => {
    generation.current++; controller.current?.abort(); controller.current = null;
    const source = selected.current; selected.current = null;
    if (source) void fileService.releaseReplaySources(source.grantId).catch(console.debug);
    if (mounted.current) { setPicked(null); setIsImporting(false); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelImport(); }; }, [cancelImport]);
  const startImport = useCallback(async () => {
    if (pickerPending.current || controller.current || selected.current) return;
    pickerPending.current = true;
    const epoch = ++generation.current;
    setIsPicking(true);
    try {
      const source = await fileService.pickReplaySources();
      if (!mounted.current || generation.current !== epoch) { if (source) await fileService.releaseReplaySources(source.grantId); return; }
      selected.current = source; setPicked(source);
    } finally { pickerPending.current = false; if (mounted.current) setIsPicking(false); }
  }, []);
  const confirmImport = useCallback(async (plans: ReplayTrackPlan[]) => {
    const source = selected.current; if (!source || controller.current) return;
    const abort = new AbortController(); controller.current = abort; setIsImporting(true);
    try {
      if (replacing) {
        const previous = replacing.tracks.flatMap(track => track.files);
        if (previous.length !== source.sources.length || previous.some(file => !source.sources.some(item => item.path === file.path && item.size === file.size && item.fingerprint === file.fingerprint))) throw new Error('Replay source changed; import as a new session instead');
        if (plans.length !== replacing.tracks.length) throw new Error('Restore requires the original track/shard arrangement');
      }
      const session = await importReplaySources(source, plans, abort.signal, replacing);
      if (mounted.current && !abort.signal.aborted) { if (!replacing) openReplaySession(session); selected.current = null; setPicked(null); }
    } finally {
      await fileService.releaseReplaySources(source.grantId).catch(error => console.debug('[replay] release failed', error));
      if (controller.current === abort) { controller.current = null; selected.current = null; if (mounted.current) { setPicked(null); setIsImporting(false); } }
    }
  }, [replacing]);
  return { picked, isImporting, isPicking, startImport, confirmImport, cancelImport };
}
