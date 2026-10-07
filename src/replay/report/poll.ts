/** Keep rendering freshness separately; network reads run at most once per five minutes. */
export class LivePoller {
  private nextAt = 0;
  private pending = false;
  private failures = 0;
  constructor(private readonly refresh: () => Promise<void>, private readonly visible: () => boolean,
    private readonly now: () => number = Date.now) {}
  async tick(): Promise<void> {
    if (!this.visible() || this.pending || this.now() < this.nextAt) return;
    this.pending = true;
    try { await this.refresh(); this.failures = 0; }
    catch { this.failures = Math.min(3, this.failures + 1); }
    finally {
      this.nextAt = this.now() + Math.min(1800000, 300000 * 2 ** this.failures);
      this.pending = false;
    }
  }
}
