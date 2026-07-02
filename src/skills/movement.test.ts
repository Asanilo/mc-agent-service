import { describe, it, expect } from "vitest";
import {
  moveToPosition,
  moveToBlock,
  moveToEntity,
  moveFollowPlayer,
  moveAvoidEnemies,
} from "./movement.js";

describe("movement skill schemas (P0 #1 — distance unification)", () => {
  // ── move.to_position ──────────────────────────────────────────────────

  describe("move.to_position", () => {
    const validParams = { x: 0, y: 64, z: 0 };

    it("accepts distance parameter", () => {
      const result = moveToPosition.parameters.safeParse({ ...validParams, distance: 5 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("distance", 5);
      }
    });

    it("defaults distance to 2", () => {
      const result = moveToPosition.parameters.safeParse(validParams);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("distance", 2);
      }
    });

    it("rejects minDistance (old name)", () => {
      const result = moveToPosition.parameters.safeParse({ ...validParams, minDistance: 5 });
      expect(result.success).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = moveToPosition.parameters.safeParse({ x: 0 });
      expect(result.success).toBe(false);
    });
  });

  // ── move.to_block ─────────────────────────────────────────────────────

  describe("move.to_block", () => {
    const validParams = { blockType: "stone" };

    it("accepts distance parameter (was minDistance)", () => {
      const result = moveToBlock.parameters.safeParse({ ...validParams, distance: 3, range: 32 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("distance", 3);
      }
    });

    it("rejects minDistance (old name)", () => {
      const result = moveToBlock.parameters.safeParse({ ...validParams, minDistance: 3 });
      expect(result.success).toBe(false);
    });
  });

  // ── move.to_entity ────────────────────────────────────────────────────

  describe("move.to_entity", () => {
    it("accepts distance parameter (was minDistance)", () => {
      const result = moveToEntity.parameters.safeParse({ entityType: "cow", distance: 3 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("distance", 3);
      }
    });

    it("rejects minDistance (old name)", () => {
      const result = moveToEntity.parameters.safeParse({ entityType: "cow", minDistance: 3 });
      expect(result.success).toBe(false);
    });
  });

  // ── Skills that already used distance (should still work) ─────────────

  describe("skills that already used distance", () => {
    it("move.follow_player accepts distance", () => {
      const result = moveFollowPlayer.parameters.safeParse({ username: "test", distance: 5 });
      expect(result.success).toBe(true);
    });

    it("move.avoid_enemies accepts distance", () => {
      const result = moveAvoidEnemies.parameters.safeParse({ distance: 16 });
      expect(result.success).toBe(true);
    });
  });
});
