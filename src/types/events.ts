import { z } from "zod";
import { ISODateTimeSchema, Vec3Schema } from "./config.js";
import { BotSummarySchema, BotStateSchema, InventorySnapshotSchema, ModeStatusSchema, ServiceErrorObjectSchema, ChatMessageSchema, EntitySummarySchema } from "./bot.js";
import { JobSchema, JobProgressSchema, JobErrorSchema, CancellationModeSchema } from "./jobs.js";

// ─── Service Event Envelope ─────────────────────────────────────────────────

export const ServiceEventBaseSchema = z
  .object({
    id: z.string(),
    ts: ISODateTimeSchema,
    type: z.string(),
    botId: z.string().optional(),
    jobId: z.string().optional(),
    data: z.unknown(),
  })
  .strict();

// ─── Event Data Schemas ─────────────────────────────────────────────────────

export const BotConnectedDataSchema = z
  .object({
    bot: BotSummarySchema,
    host: z.string(),
    port: z.number().int(),
  })
  .strict();
export type BotConnectedData = z.infer<typeof BotConnectedDataSchema>;

export const BotDisconnectedDataSchema = z
  .object({
    reason: z.string().optional(),
    expected: z.boolean(),
    willReconnect: z.boolean(),
    nextReconnectAt: ISODateTimeSchema.optional(),
  })
  .strict();
export type BotDisconnectedData = z.infer<typeof BotDisconnectedDataSchema>;

export const BotKickedDataSchema = z
  .object({
    reason: z.string(),
    loggedIn: z.boolean(),
    willReconnect: z.boolean(),
  })
  .strict();
export type BotKickedData = z.infer<typeof BotKickedDataSchema>;

export const BotSpawnedDataSchema = z
  .object({
    position: Vec3Schema,
    dimension: z.string().optional(),
    gameMode: z.string().optional(),
  })
  .strict();
export type BotSpawnedData = z.infer<typeof BotSpawnedDataSchema>;

export const ChatReceivedDataSchema = ChatMessageSchema;
export type ChatReceivedData = z.infer<typeof ChatReceivedDataSchema>;

export const ChatSentDataSchema = ChatMessageSchema;
export type ChatSentData = z.infer<typeof ChatSentDataSchema>;

export const StateChangedDataSchema = BotStateSchema;
export type StateChangedData = z.infer<typeof StateChangedDataSchema>;

export const InventoryChangedSlotSchema = z
  .object({
    slot: z.number().int(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })
  .strict();

export const InventoryChangedDataSchema = z
  .object({
    inventory: InventorySnapshotSchema,
    changedSlots: z.array(InventoryChangedSlotSchema),
  })
  .strict();
export type InventoryChangedData = z.infer<typeof InventoryChangedDataSchema>;

export const JobStartedDataSchema = JobSchema;
export type JobStartedData = z.infer<typeof JobStartedDataSchema>;

export const JobProgressDataSchema = z
  .object({
    job: JobSchema,
    progress: JobProgressSchema,
  })
  .strict();
export type JobProgressData = z.infer<typeof JobProgressDataSchema>;

export const JobCompletedDataSchema = z
  .object({
    job: JobSchema,
    result: z.unknown().optional(),
  })
  .strict();
export type JobCompletedData = z.infer<typeof JobCompletedDataSchema>;

export const JobFailedDataSchema = z
  .object({
    job: JobSchema,
    error: JobErrorSchema,
  })
  .strict();
export type JobFailedData = z.infer<typeof JobFailedDataSchema>;

export const JobCancelledDataSchema = z
  .object({
    job: JobSchema,
    reason: z.string().optional(),
    mode: CancellationModeSchema,
  })
  .strict();
export type JobCancelledData = z.infer<typeof JobCancelledDataSchema>;

export const ModeTriggeredDataSchema = z
  .object({
    mode: ModeStatusSchema,
    reason: z.string(),
    action: z.string().optional(),
  })
  .strict();
export type ModeTriggeredData = z.infer<typeof ModeTriggeredDataSchema>;

export const ErrorRaisedDataSchema = z
  .object({
    error: ServiceErrorObjectSchema,
  })
  .strict();
export type ErrorRaisedData = z.infer<typeof ErrorRaisedDataSchema>;

// ─── Typed Service Events (discriminated union) ─────────────────────────────

export const BotConnectedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("bot.connected"),
  botId: z.string(),
  data: BotConnectedDataSchema,
}).strict();

export const BotDisconnectedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("bot.disconnected"),
  botId: z.string(),
  data: BotDisconnectedDataSchema,
}).strict();

export const BotKickedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("bot.kicked"),
  botId: z.string(),
  data: BotKickedDataSchema,
}).strict();

export const BotSpawnedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("bot.spawned"),
  botId: z.string(),
  data: BotSpawnedDataSchema,
}).strict();

export const ChatReceivedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("chat.received"),
  botId: z.string(),
  data: ChatReceivedDataSchema,
}).strict();

export const ChatSentEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("chat.sent"),
  botId: z.string(),
  jobId: z.string().optional(),
  data: ChatSentDataSchema,
}).strict();

export const StateChangedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("state.changed"),
  botId: z.string(),
  data: StateChangedDataSchema,
}).strict();

export const InventoryChangedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("inventory.changed"),
  botId: z.string(),
  data: InventoryChangedDataSchema,
}).strict();

export const JobStartedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("job.started"),
  botId: z.string(),
  jobId: z.string(),
  data: JobStartedDataSchema,
}).strict();

export const JobProgressEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("job.progress"),
  botId: z.string(),
  jobId: z.string(),
  data: JobProgressDataSchema,
}).strict();

export const JobCompletedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("job.completed"),
  botId: z.string(),
  jobId: z.string(),
  data: JobCompletedDataSchema,
}).strict();

export const JobFailedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("job.failed"),
  botId: z.string(),
  jobId: z.string(),
  data: JobFailedDataSchema,
}).strict();

export const JobCancelledEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("job.cancelled"),
  botId: z.string(),
  jobId: z.string(),
  data: JobCancelledDataSchema,
}).strict();

export const ModeTriggeredEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("mode.triggered"),
  botId: z.string(),
  data: ModeTriggeredDataSchema,
}).strict();

export const ErrorRaisedEventSchema = ServiceEventBaseSchema.extend({
  type: z.literal("error.raised"),
  botId: z.string().optional(),
  jobId: z.string().optional(),
  data: ErrorRaisedDataSchema,
}).strict();

// ─── Full Discriminated Union ───────────────────────────────────────────────

export const ServiceEventSchema = z.discriminatedUnion("type", [
  BotConnectedEventSchema,
  BotDisconnectedEventSchema,
  BotKickedEventSchema,
  BotSpawnedEventSchema,
  ChatReceivedEventSchema,
  ChatSentEventSchema,
  StateChangedEventSchema,
  InventoryChangedEventSchema,
  JobStartedEventSchema,
  JobProgressEventSchema,
  JobCompletedEventSchema,
  JobFailedEventSchema,
  JobCancelledEventSchema,
  ModeTriggeredEventSchema,
  ErrorRaisedEventSchema,
]);
export type ServiceEvent = z.infer<typeof ServiceEventSchema>;

// ─── Individual Event Type Aliases ───────────────────────────────────────────

export type BotConnectedEvent = z.infer<typeof BotConnectedEventSchema>;
export type BotDisconnectedEvent = z.infer<typeof BotDisconnectedEventSchema>;
export type BotKickedEvent = z.infer<typeof BotKickedEventSchema>;
export type BotSpawnedEvent = z.infer<typeof BotSpawnedEventSchema>;
export type ChatReceivedEvent = z.infer<typeof ChatReceivedEventSchema>;
export type ChatSentEvent = z.infer<typeof ChatSentEventSchema>;
export type StateChangedEvent = z.infer<typeof StateChangedEventSchema>;
export type InventoryChangedEvent = z.infer<typeof InventoryChangedEventSchema>;
export type JobStartedEvent = z.infer<typeof JobStartedEventSchema>;
export type JobProgressEvent = z.infer<typeof JobProgressEventSchema>;
export type JobCompletedEvent = z.infer<typeof JobCompletedEventSchema>;
export type JobFailedEvent = z.infer<typeof JobFailedEventSchema>;
export type JobCancelledEvent = z.infer<typeof JobCancelledEventSchema>;
export type ModeTriggeredEvent = z.infer<typeof ModeTriggeredEventSchema>;
export type ErrorRaisedEvent = z.infer<typeof ErrorRaisedEventSchema>;
