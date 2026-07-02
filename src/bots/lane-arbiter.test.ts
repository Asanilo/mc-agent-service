import { describe, it, expect, beforeEach } from "vitest";
import { LaneArbiter } from "./lane-arbiter.js";

describe("LaneArbiter", () => {
  let arbiter: LaneArbiter;

  beforeEach(() => {
    arbiter = new LaneArbiter();
  });

  // ── Primary lane ──────────────────────────────────────────────────────

  describe("primary lane", () => {
    it("acquires when idle", () => {
      expect(arbiter.primaryRunning).toBe(false);
      expect(arbiter.acquirePrimary()).toBe(true);
      expect(arbiter.primaryRunning).toBe(true);
    });

    it("rejects when primary is already running", () => {
      arbiter.acquirePrimary();
      expect(arbiter.acquirePrimary()).toBe(false);
      expect(arbiter.primaryRunning).toBe(true);
    });

    it("releases and allows re-acquire", () => {
      arbiter.acquirePrimary();
      arbiter.releasePrimary();
      expect(arbiter.primaryRunning).toBe(false);
      expect(arbiter.acquirePrimary()).toBe(true);
    });

    it("rejects when emergency is active", () => {
      arbiter.emergencyStop();
      expect(arbiter.acquirePrimary()).toBe(false);
    });

    it("allows acquire after resetEmergency", () => {
      arbiter.emergencyStop();
      arbiter.resetEmergency();
      expect(arbiter.acquirePrimary()).toBe(true);
    });
  });

  // ── Primary queue ─────────────────────────────────────────────────────

  describe("primary queue", () => {
    it("queues entries in FIFO order", () => {
      arbiter.enqueuePrimary({ jobId: "j1", skill: "s1", params: {} });
      arbiter.enqueuePrimary({ jobId: "j2", skill: "s2", params: {} });
      expect(arbiter.primaryQueueLength).toBe(2);

      expect(arbiter.dequeuePrimary()).toMatchObject({ jobId: "j1" });
      expect(arbiter.dequeuePrimary()).toMatchObject({ jobId: "j2" });
      expect(arbiter.dequeuePrimary()).toBeUndefined();
    });

    it("hasQueuedPrimary returns correct state", () => {
      expect(arbiter.hasQueuedPrimary()).toBe(false);
      arbiter.enqueuePrimary({ jobId: "j1", skill: "s1", params: {} });
      expect(arbiter.hasQueuedPrimary()).toBe(true);
      arbiter.dequeuePrimary();
      expect(arbiter.hasQueuedPrimary()).toBe(false);
    });
  });

  // ── Observation lane ──────────────────────────────────────────────────

  describe("observation lane", () => {
    it("tracks concurrent observation count", () => {
      expect(arbiter.observationRunning).toBe(0);
      arbiter.startObservation();
      expect(arbiter.observationRunning).toBe(1);
      arbiter.startObservation();
      expect(arbiter.observationRunning).toBe(2);
      arbiter.endObservation();
      expect(arbiter.observationRunning).toBe(1);
      arbiter.endObservation();
      expect(arbiter.observationRunning).toBe(0);
    });

    it("endObservation does not go negative", () => {
      arbiter.endObservation();
      expect(arbiter.observationRunning).toBe(0);
    });

    it("observation runs in parallel with primary", () => {
      arbiter.acquirePrimary();
      arbiter.startObservation();
      expect(arbiter.primaryRunning).toBe(true);
      expect(arbiter.observationRunning).toBe(1);
    });
  });

  // ── Emergency stop ────────────────────────────────────────────────────

  describe("emergency stop", () => {
    it("clears primary queue", () => {
      arbiter.enqueuePrimary({ jobId: "j1", skill: "s1", params: {} });
      arbiter.enqueuePrimary({ jobId: "j2", skill: "s2", params: {} });
      arbiter.emergencyStop();
      expect(arbiter.primaryQueueLength).toBe(0);
      expect(arbiter.hasQueuedPrimary()).toBe(false);
    });

    it("releases primary lane", () => {
      arbiter.acquirePrimary();
      arbiter.emergencyStop();
      expect(arbiter.primaryRunning).toBe(false);
    });

    it("sets emergencyActive flag", () => {
      expect(arbiter.emergencyActive).toBe(false);
      arbiter.emergencyStop();
      expect(arbiter.emergencyActive).toBe(true);
    });

    it("blocks new primary acquisitions", () => {
      arbiter.emergencyStop();
      expect(arbiter.acquirePrimary()).toBe(false);
      arbiter.enqueuePrimary({ jobId: "j1", skill: "s1", params: {} });
      expect(arbiter.primaryQueueLength).toBe(0); // also cleared
    });

    it("does NOT affect observation lane", () => {
      arbiter.startObservation();
      arbiter.emergencyStop();
      expect(arbiter.observationRunning).toBe(1);
    });
  });

  // ── Reset all ─────────────────────────────────────────────────────────

  describe("resetAll", () => {
    it("resets all state", () => {
      arbiter.acquirePrimary();
      arbiter.enqueuePrimary({ jobId: "j1", skill: "s1", params: {} });
      arbiter.startObservation();
      arbiter.emergencyStop();

      arbiter.resetAll();

      expect(arbiter.primaryRunning).toBe(false);
      expect(arbiter.primaryQueueLength).toBe(0);
      expect(arbiter.observationRunning).toBe(0);
      expect(arbiter.emergencyActive).toBe(false);
    });
  });
});
