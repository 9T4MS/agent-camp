/** Deliberately authored office content, never transcript/status history. */
import { z } from "zod";

export const MESSAGE_RETENTION_MS = 86_400_000;
export const MESSAGE_MAX_ROWS = 100;
export const MESSAGE_DAILY_CAP = 200;
export const MESSAGE_MAX_RECIPIENTS = 50;
/** Limits count UTF-16 code units, just like textarea.maxLength and connector text. */
export const MessageText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((text) => text.length <= 200, "at most 200 UTF-16 code units");
const PersonId = z.string().min(1).max(64);
const Sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MessageAudience = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("everyone") }),
  z.strictObject({
    kind: z.literal("selected"),
    personIds: z
      .array(PersonId)
      .min(1)
      .max(MESSAGE_MAX_RECIPIENTS)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate recipients"),
  }),
]);
export const SendMessageRequest = z.strictObject({
  audience: MessageAudience,
  text: MessageText,
  from: z.string().trim().max(40).optional(),
  notifyDesktop: z.boolean(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
export const MessageRecord = z.object({
  id: z.string().min(1).max(64),
  seq: Sequence.positive(),
  ts: z.number().int().nonnegative(),
  from: z.string().max(40).optional(),
  text: MessageText,
  audience: z.enum(["everyone", "selected"]),
  recipients: z.array(z.object({ personId: PersonId, name: z.string().min(1).max(40) })),
  notifyDesktop: z.boolean(),
});
export type MessageRecord = z.infer<typeof MessageRecord>;
export const SendMessageResponse = z.object({
  ok: z.literal(true),
  message: MessageRecord,
  /** Accepted connector socket sends, not people or OS display receipts. Never persisted. */
  queued: z.number().int().nonnegative(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;
export const DeleteMessageResponse = z.object({ ok: z.literal(true) });
export const MessagePage = z.object({
  messages: z.array(MessageRecord).max(100),
  /** IDs deletable by this sending browser; never included in office-wide events. */
  ownedIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  head: Sequence,
  older: Sequence.nullable(),
  next: Sequence,
  hasMore: z.boolean(),
  gap: z.boolean(),
  retention: z.object({
    maxAgeMs: z.number(),
    maxRows: z.number(),
    expiresAt: z.number().nullable(),
  }),
});
export type MessagePage = z.infer<typeof MessagePage>;
const Cursor = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(Sequence);
export const MessageQuery = z
  .object({
    limit: Cursor.pipe(z.number().min(1).max(100)).optional().default(50),
    before: Cursor.optional(),
    after: Cursor.optional(),
  })
  .refine((q) => q.before === undefined || q.after === undefined, "use before or after, not both");
export type MessageQuery = z.output<typeof MessageQuery>;
