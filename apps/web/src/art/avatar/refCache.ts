/**
 * Reference-counted cache: `acquire(key)` builds a value once and shares it, `release(value)`
 * drops one reference and disposes the value when nobody holds it any more. Character sheets
 * use it so free-hex looks don't pile up GPU textures forever.
 */
export class RefCache<V> {
  private readonly entries = new Map<string, { value: V; refs: number }>();
  private readonly keys = new Map<V, string>();

  constructor(
    private readonly make: (key: string) => V,
    private readonly dispose: (value: V) => void,
  ) {}

  acquire(key: string): V {
    let e = this.entries.get(key);
    if (!e) {
      e = { value: this.make(key), refs: 0 };
      this.entries.set(key, e);
      this.keys.set(e.value, key);
    }
    e.refs++;
    return e.value;
  }

  /** One more reference to a value this cache handed out; false (no-op) for unknown values. */
  retain(value: V): boolean {
    const key = this.keys.get(value);
    if (key === undefined) return false;
    this.entries.get(key)!.refs++;
    return true;
  }

  /** Drop one reference; unknown values are ignored. */
  release(value: V): void {
    const key = this.keys.get(value);
    if (key === undefined) return;
    const e = this.entries.get(key)!;
    if (--e.refs > 0) return;
    this.entries.delete(key);
    this.keys.delete(value);
    this.dispose(value);
  }

  get size(): number {
    return this.entries.size;
  }

  refs(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }
}
