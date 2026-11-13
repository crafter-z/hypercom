/** Sparse, bounded measured-height corrections over a uniform estimate.
 * Unvisited records cost no allocation/decoding. Keys are stable source seqs
 * (or absolute positions in the current filtered array), never viewport indices.
 * An augmented AVL gives logarithmic prefix sums; FIFO eviction bounds memory
 * even when browsing an arbitrarily large replay. Evicted heights are estimates
 * again; the renderer preserves its record + intra-record reading anchor.
 */
interface Node {
  key: number;
  delta: number;
  sum: number;
  rank: number;
  left: Node | null;
  right: Node | null;
}
const rank = (n: Node | null) => n?.rank ?? 0;
const sum = (n: Node | null) => n?.sum ?? 0;
function refresh(n: Node): Node {
  n.rank = 1 + Math.max(rank(n.left), rank(n.right));
  n.sum = n.delta + sum(n.left) + sum(n.right);
  return n;
}
function left(n: Node): Node {
  const root = n.right!;
  n.right = root.left; root.left = refresh(n);
  return refresh(root);
}
function right(n: Node): Node {
  const root = n.left!;
  n.left = root.right; root.right = refresh(n);
  return refresh(root);
}
function balance(n: Node): Node {
  refresh(n);
  if (rank(n.left) - rank(n.right) > 1) {
    if (rank(n.left!.left) < rank(n.left!.right)) n.left = left(n.left!);
    return right(n);
  }
  if (rank(n.right) - rank(n.left) > 1) {
    if (rank(n.right!.right) < rank(n.right!.left)) n.right = right(n.right!);
    return left(n);
  }
  return n;
}
function put(n: Node | null, key: number, delta: number): Node | null {
  if (!n) return delta === 0 ? null : { key, delta, sum: delta, rank: 1, left: null, right: null };
  if (key < n.key) n.left = put(n.left, key, delta);
  else if (key > n.key) n.right = put(n.right, key, delta);
  else if (delta !== 0) n.delta = delta;
  else {
    if (!n.left) return n.right;
    if (!n.right) return n.left;
    let next = n.right;
    while (next.left) next = next.left;
    n.key = next.key; n.delta = next.delta;
    n.right = put(n.right, next.key, 0);
  }
  return balance(n);
}

export const TERMINAL_HEIGHT_CACHE_SIZE = 8192;
export class TerminalHeightIndex {
  private root: Node | null = null;
  private measured = new Map<number, number>();
  constructor(readonly estimate: number, private readonly capacity = TERMINAL_HEIGHT_CACHE_SIZE) {}
  get size(): number { return this.measured.size; }
  clear(): void { this.root = null; this.measured.clear(); }
  height(key: number): number { return this.measured.get(key) ?? this.estimate; }
  set(key: number, height: number): boolean {
    if (!Number.isFinite(height)) return false;
    const value = Math.max(this.estimate, height);
    if (value === this.height(key)) return false;
    this.root = put(this.root, key, value - this.estimate);
    if (value === this.estimate) this.measured.delete(key);
    else this.measured.set(key, value);
    if (this.measured.size > this.capacity) {
      const oldest = this.measured.keys().next().value!;
      this.measured.delete(oldest);
      this.root = put(this.root, oldest, 0);
    }
    return true;
  }
  trimBefore(first: number): void {
    while (this.root) {
      let oldest = this.root;
      while (oldest.left) oldest = oldest.left;
      if (oldest.key >= first) break;
      this.measured.delete(oldest.key);
      this.root = put(this.root, oldest.key, 0);
    }
  }
  private extraBefore(key: number): number {
    let n = this.root, total = 0;
    while (n) {
      if (n.key >= key) n = n.left;
      else { total += sum(n.left) + n.delta; n = n.right; }
    }
    return total;
  }
  range(first: number, end: number): number {
    return Math.max(0, end - first) * this.estimate + this.extraBefore(end) - this.extraBefore(first);
  }
  /** Key containing the point, clamped to the nonempty [first, first+count). */
  keyAt(first: number, count: number, point: number): number {
    let lo = first, hi = first + count - 1;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (this.range(first, mid + 1) <= point) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
