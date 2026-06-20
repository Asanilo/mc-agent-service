/**
 * EventBus — typed in-process pub/sub channel for mc-agent-service.
 *
 * Responsibilities (from SPEC §3):
 *  - Accept events from workers and control-plane services.
 *  - Attach monotonically increasing event IDs and timestamps.
 *  - Fan out events to WebSocket clients.
 *  - Provide filtered subscriptions.
 *
 * Events must be JSON-serializable and must not contain Mineflayer object references.
 */

import { EventEmitter } from "node:events";
import type { ServiceEvent } from "../types/events.js";

// ─── Filter predicate ──────────────────────────────────────────────────────

export type EventFilter = (event: ServiceEvent) => boolean;

export interface EventSubscription {
  id: string;
  filter: EventFilter;
  handler: EventHandler;
}

export type EventHandler = (event: ServiceEvent) => void;

// ─── EventBus ──────────────────────────────────────────────────────────────

export class EventBus {
  private readonly emitter = new EventEmitter();
  private seq = 0;
  private subSeq = 0;
  private readonly subscriptions = new Map<string, EventSubscription>();

  // We use a high limit since many modules may subscribe.
  constructor(maxListeners = 256) {
    this.emitter.setMaxListeners(maxListeners);
  }

  // ── Core emit / on / off ────────────────────────────────────────────────

  /**
   * Emit a service event. Automatically attaches a monotonic event `id`
   * (format `evt_<seq>`) and an ISO-8601 `ts` if not already present.
   */
  emit(event: ServiceEvent): void {
    const stamped: ServiceEvent = {
      ...event,
      id: event.id || this.nextId(),
      ts: event.ts || new Date().toISOString(),
    } as ServiceEvent;

    this.emitter.emit(stamped.type, stamped);
    this.emitter.emit("*", stamped); // wildcard for catch-all listeners

    // Fan out to filtered subscriptions
    for (const sub of this.subscriptions.values()) {
      try {
        if (sub.filter(stamped)) {
          sub.handler(stamped);
        }
      } catch {
        // subscriber errors must not break the bus
      }
    }
  }

  /**
   * Register a handler for a specific event type.
   */
  on(eventType: string, handler: EventHandler): void {
    this.emitter.on(eventType, handler);
  }

  /**
   * Remove a handler for a specific event type.
   */
  off(eventType: string, handler: EventHandler): void {
    this.emitter.off(eventType, handler);
  }

  // ── Filtered subscriptions ──────────────────────────────────────────────

  /**
   * Create a filtered subscription. Returns an unsubscribe handle.
   * The handler is called only when `filter` returns true.
   */
  subscribe(filter: EventFilter, handler: EventHandler): EventSubscription {
    const id = `sub_${++this.subSeq}`;
    const sub: EventSubscription = { id, filter, handler };
    this.subscriptions.set(id, sub);
    return sub;
  }

  /**
   * Remove a previously created filtered subscription.
   */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  // ── Wildcard (catch-all) convenience ────────────────────────────────────

  /**
   * Register a handler that receives every event regardless of type.
   */
  onAll(handler: EventHandler): void {
    this.emitter.on("*", handler);
  }

  /**
   * Remove a catch-all handler.
   */
  offAll(handler: EventHandler): void {
    this.emitter.off("*", handler);
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  /**
   * Remove all listeners and subscriptions. Useful for testing.
   */
  clear(): void {
    this.emitter.removeAllListeners();
    this.subscriptions.clear();
  }

  /** Number of listeners for a given event type (excluding filtered subs). */
  listenerCount(eventType: string): number {
    return this.emitter.listenerCount(eventType);
  }

  private nextId(): string {
    return `evt_${++this.seq}`;
  }
}

// ── Singleton instance ──────────────────────────────────────────────────────

export const eventBus = new EventBus();
