/** AVL tree keyed by (time, seq): stable duplicates, arbitrary clock rollback.
 * Contains only eligible visible records, so queries never probe hidden spans.
 * Deletion releases trimmed records; no historical tombstones or snapshots. */
interface Entry { time: number; seq: number }
interface Node extends Entry { left: Node | null; right: Node | null; height: number }
const height = (n: Node | null): number => n?.height ?? 0;
function update(n: Node): Node { n.height = 1 + Math.max(height(n.left), height(n.right)); return n; }
function rotateLeft(n: Node): Node {
  const root = n.right!; n.right = root.left; root.left = update(n); return update(root);
}
function rotateRight(n: Node): Node {
  const root = n.left!; n.left = root.right; root.right = update(n); return update(root);
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
function compare(a: Entry, b: Entry): number { return a.time - b.time || a.seq - b.seq; }
function insert(n: Node | null, e: Entry): Node {
  if (!n) return { ...e, left: null, right: null, height: 1 };
  const cmp = compare(e, n);
  if (cmp < 0) n.left = insert(n.left, e);
  else if (cmp > 0) n.right = insert(n.right, e);
  return balance(n);
}
function remove(n: Node | null, e: Entry): Node | null {
  if (!n) return null;
  const cmp = compare(e, n);
  if (cmp < 0) n.left = remove(n.left, e);
  else if (cmp > 0) n.right = remove(n.right, e);
  else {
    if (!n.left) return n.right;
    if (!n.right) return n.left;
    let next = n.right;
    while (next.left) next = next.left;
    n.time = next.time; n.seq = next.seq;
    n.right = remove(n.right, next);
  }
  return balance(n);
}
export class TerminalTimeIndex {
  private root: Node | null = null;
  private times = new Map<number, number>();
  get size(): number { return this.times.size; }
  clear(): void { this.root = null; this.times.clear(); }
  add(seq: number, time: number | null): void {
    if (time === null || !Number.isFinite(time)) return;
    if (this.times.has(seq)) this.delete(seq);
    this.times.set(seq, time);
    this.root = insert(this.root, { seq, time });
  }
  delete(seq: number): void {
    const time = this.times.get(seq);
    if (time === undefined) return;
    this.times.delete(seq);
    this.root = remove(this.root, { seq, time });
  }
  /** Latest stable seq at the latest time <= target (first record if before). */
  lookup(time: number): { entry: Entry; status: 'exact' | 'nearest' | 'before-range' | 'after-range' } | null {
    if (!this.root || !Number.isFinite(time)) return null;
    let n: Node | null = this.root, candidate: Entry | null = null;
    while (n) {
      if (n.time <= time) { candidate = { time: n.time, seq: n.seq }; n = n.right; }
      else n = n.left;
    }
    let first = this.root, last = this.root;
    while (first.left) first = first.left;
    while (last.right) last = last.right;
    if (!candidate) return { entry: { time: first.time, seq: first.seq }, status: 'before-range' };
    return { entry: candidate, status: time > last.time ? 'after-range' : candidate.time === time ? 'exact' : 'nearest' };
  }
}
