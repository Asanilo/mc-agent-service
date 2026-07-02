/**
 * LaneArbiter — action lane arbitration for bot workers.
 *
 * Per SPEC §9.2, each bot has four lanes:
 *   SYSTEM      — lifecycle commands (disconnect, destroy, emergency stop). Preempts all.
 *   SAFETY      — ModeEngine background modes. Respects primary conflicts.
 *   PRIMARY     — one-at-a-time world-mutating skills (movement, mining, combat, etc.).
 *   OBSERVATION — read-only skills that can run in parallel with primary.
 *
 * Arbitration rules:
 *   - Only one PRIMARY action runs at a time; queued entries drain in order.
 *   - OBSERVATION skills run in parallel with PRIMARY (no queue).
 *   - SYSTEM (emergency stop) preempts PRIMARY and clears its queue.
 *   - SAFETY lane is managed by ModeEngine (priority + pause scopes via ModeEngine itself).
 */

export enum Lane {
  SYSTEM = "system",
  SAFETY = "safety",
  PRIMARY = "primary",
  OBSERVATION = "observation",
}

export interface PrimaryEntry {
  jobId: string;
  skill: string;
  params: unknown;
  timeoutMs?: number;
}

export class LaneArbiter {
  private _primaryRunning = false;
  private _primaryQueue: PrimaryEntry[] = [];
  private _observationRunning = 0;
  private _emergencyActive = false;

  // ── Primary lane ───────────────────────────────────────────────────────

  /** Whether the primary lane is currently occupied. */
  get primaryRunning(): boolean {
    return this._primaryRunning;
  }

  /** Try to acquire the primary lane. Returns false if busy (caller must queue). */
  acquirePrimary(): boolean {
    if (this._primaryRunning || this._emergencyActive) return false;
    this._primaryRunning = true;
    return true;
  }

  /** Release the primary lane. */
  releasePrimary(): void {
    this._primaryRunning = false;
  }

  // ── Primary queue ─────────────────────────────────────────────────────

  enqueuePrimary(entry: PrimaryEntry): void {
    if (this._emergencyActive) return; // reject during emergency stop
    this._primaryQueue.push(entry);
  }

  dequeuePrimary(): PrimaryEntry | undefined {
    return this._primaryQueue.shift();
  }

  hasQueuedPrimary(): boolean {
    return this._primaryQueue.length > 0;
  }

  /** Number of entries waiting in the primary queue. */
  get primaryQueueLength(): number {
    return this._primaryQueue.length;
  }

  // ── Observation lane ───────────────────────────────────────────────────

  /** Number of currently running observation skills. */
  get observationRunning(): number {
    return this._observationRunning;
  }

  /** Start an observation skill. No limit — always allowed. */
  startObservation(): void {
    this._observationRunning++;
  }

  /** End an observation skill. */
  endObservation(): void {
    if (this._observationRunning > 0) this._observationRunning--;
  }

  // ── Emergency (system) ─────────────────────────────────────────────────

  /** Whether emergency-stop mode has been activated. */
  get emergencyActive(): boolean {
    return this._emergencyActive;
  }

  /**
   * Activate emergency stop: clear the primary queue and cancel any
   * in-flight primary. Does NOT affect observation skills.
   */
  emergencyStop(): void {
    this._emergencyActive = true;
    this._primaryRunning = false;
    this._primaryQueue = [];
  }

  /** Reset emergency mode (called after reconnect, etc.). */
  resetEmergency(): void {
    this._emergencyActive = false;
  }

  // ── Full reset (worker teardown) ─────────────────────────────────────

  /** Reset all lanes to initial state. */
  resetAll(): void {
    this._primaryRunning = false;
    this._primaryQueue = [];
    this._observationRunning = 0;
    this._emergencyActive = false;
  }
}
