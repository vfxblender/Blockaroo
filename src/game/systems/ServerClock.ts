const MAX_PING_ROUND_TRIP_MS = 10_000;
const CLOCK_SAMPLE_WEIGHT = 0.2;

/**
 * Converts browser wall-clock timestamps into the world server's clock.
 * Browser clocks can differ from Cloudflare by seconds, so movement and
 * message expiry must never compare the two clocks directly.
 */
export class ServerClock {
  private offsetMs = 0;
  private hasPingSample = false;

  reset(): void {
    this.offsetMs = 0;
    this.hasPingSample = false;
  }

  observeWelcome(serverTime: number, receivedAt = Date.now()): void {
    if (!Number.isFinite(serverTime) || !Number.isFinite(receivedAt)) return;
    this.offsetMs = serverTime - receivedAt;
    this.hasPingSample = false;
  }

  observePong(sentAt: number, serverTime: number, receivedAt = Date.now()): boolean {
    const roundTripMs = receivedAt - sentAt;
    if (!Number.isFinite(roundTripMs)
      || !Number.isFinite(serverTime)
      || roundTripMs < 0
      || roundTripMs > MAX_PING_ROUND_TRIP_MS) return false;

    const sample = serverTime + (roundTripMs / 2) - receivedAt;
    this.offsetMs = this.hasPingSample
      ? this.offsetMs + ((sample - this.offsetMs) * CLOCK_SAMPLE_WEIGHT)
      : sample;
    this.hasPingSample = true;
    return true;
  }

  toServerTime(localTime = Date.now()): number {
    return localTime + this.offsetMs;
  }

  toLocalTime(serverTime: number): number {
    return serverTime - this.offsetMs;
  }

  get estimatedOffsetMs(): number {
    return this.offsetMs;
  }
}
