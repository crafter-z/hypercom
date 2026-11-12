/** AVL tree keyed by (time, seq): stable duplicates, arbitrary clock rollback.
 * Contains only eligible visible records, so queries never probe hidden spans.
 * Deletion releases trimmed records; no historical tombstones or snapshots.
 *
 * The sequence map stores the existing AVL node rather than a second timestamp
 * value. This avoids retaining a duplicate HeapNumber for every record while
 * keeping delete(seq) O(log N). Nodes are never copied during deletion: a
 * two-child removal physically transplants its successor, so the map's node
 * references remain valid. Query derives range boundaries during its single
 * predecessor/lower-bound walk, so deletes do not maintain extra extrema.
 */
export interface TimeIndexEntry { time: number; seq: number }
interface Node extends TimeIndexEntry { left: Node | null; right: Node | null; height: number }

type LookupStatus = 'exact' | 'nearest' | 'before-range' | 'after-range';

const height = (n: Node | null): number => n?.height ?? 0;
function update(n: Node): Node {
  n.height = 1 + Math.max(height(n.left), height(n.right));
  return n;
}
function rotateLeft(n: Node): Node {
  const root = n.right!;
  n.right = root.left;
  root.left = update(n);
  return update(root);
}
function rotateRight(n: Node): Node {
  const root = n.left!;
  n.left = root.right;
  root.right = update(n);
  return update(root);
}
function balance(n: Node): Node {
  update(n);
  if (height(n.left) - height(n.right) > 1) {
    if (height(n.left!.right) > height(n.left!.left)) n.left = rotateLeft(n.left!);
    return rotateRight(n);
  }
  if (height(n.right) - height(n.left) > 1) {
    if (height(n.right!.left) > height(n.right!.right)) n.right = rotateRight(n.right!);
    return rotateLeft(n);
  }
  return n;
}
function compare(a: TimeIndexEntry, b: TimeIndexEntry): number {
  return a.time - b.time || a.seq - b.seq;
}
function makeNode(entry: TimeIndexEntry): Node {
  // Keep one stable object shape for all AVL records.
  return { time: entry.time, seq: entry.seq, left: null, right: null, height: 1 };
}
function insert(n: Node | null, node: Node): Node {
  if (!n) return node;
  const cmp = compare(node, n);
  if (cmp < 0) n.left = insert(n.left, node);
  else if (cmp > 0) n.right = insert(n.right, node);
  return balance(n);
}
function minimum(n: Node): Node {
  while (n.left) n = n.left;
  return n;
}
/** Remove the exact node from the tree without touching the seq map. */
function removeNode(n: Node | null, target: Node): Node | null {
  if (!n) return null;
  const cmp = compare(target, n);
  if (cmp < 0) n.left = removeNode(n.left, target);
  else if (cmp > 0) n.right = removeNode(n.right, target);
  else {
    if (!n.left) return n.right;
    if (!n.right) return n.left;

    // Physically transplant the successor instead of copying its key fields.
    // The successor object remains the same object held by nodesBySeq.
    const successor = minimum(n.right);
    n.right = removeNode(n.right, successor);
    successor.left = n.left;
    successor.right = n.right;
    return balance(successor);
  }
  return balance(n);
}

export class TerminalTimeIndex {
  private root: Node | null = null;
  private readonly nodesBySeq = new Map<number, Node>();

  get size(): number { return this.nodesBySeq.size; }

  clear(): void {
    this.root = null;
    this.nodesBySeq.clear();
  }

  add(seq: number, time: number | null): void {
    if (time === null || !Number.isFinite(time)) return;
    const previous = this.nodesBySeq.get(seq);
    if (previous) this.delete(seq);
    const node = makeNode({ seq, time });
    this.nodesBySeq.set(seq, node);
    this.root = insert(this.root, node);
  }

  delete(seq: number): void {
    const node = this.nodesBySeq.get(seq);
    if (!node) return;
    this.root = removeNode(this.root, node);
    this.nodesBySeq.delete(seq);
  }

  /** Latest stable seq at the latest time <= target (first record if before). */
  lookup(time: number): { entry: TimeIndexEntry; status: LookupStatus } | null {
    if (!this.root || !Number.isFinite(time)) return null;
    let n: Node | null = this.root;
    let candidate: Node | null = null;
    let upper: Node | null = null;
    while (n) {
      if (n.time <= time) {
        candidate = n;
        n = n.right;
      } else {
        upper = n;
        n = n.left;
      }
    }
    if (!candidate) {
      // No predecessor means upper is the global minimum.
      const first = upper!;
      return { entry: { time: first.time, seq: first.seq }, status: 'before-range' };
    }
    return {
      entry: { time: candidate.time, seq: candidate.seq },
      status: candidate.time === time ? 'exact' : upper === null ? 'after-range' : 'nearest',
    };
  }
}
