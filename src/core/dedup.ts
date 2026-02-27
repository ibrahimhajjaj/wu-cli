export class FifoDedup {
  private map = new Map<string, true>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  add(key: string): void {
    if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
    this.map.set(key, true);
  }

  get size(): number {
    return this.map.size;
  }
}
