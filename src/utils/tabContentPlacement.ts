export interface TabContentPlacement {
  tabId: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  stockVisible: boolean;
}

const listeners = new Set<() => void>();
let placements: Record<string, TabContentPlacement> = {};

export function subscribeTabContentPlacement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getTabContentPlacements(): Record<string, TabContentPlacement> { return placements; }
export function setTabContentPlacement(placement: TabContentPlacement): void {
  const previous = placements[placement.tabId];
  if (previous && previous.visible === placement.visible && previous.stockVisible === placement.stockVisible &&
    previous.rect.x === placement.rect.x && previous.rect.y === placement.rect.y &&
    previous.rect.width === placement.rect.width && previous.rect.height === placement.rect.height) return;
  placements = { ...placements, [placement.tabId]: placement };
  for (const listener of listeners) listener();
}
export function removeTabContentPlacement(tabId: string): void {
  if (!placements[tabId]) return;
  const next = { ...placements }; delete next[tabId]; placements = next;
  for (const listener of listeners) listener();
}
