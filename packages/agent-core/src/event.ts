/**
 * Canonical agent event payload (§10.2) as zod schemas + inferred types — the typed
 * contract every adapter, the normalizer, and the sender share.
 *
 * LOCKSTEP (§16.4): field-for-field identical to the product `packages/schemas`
 * `event.ts` (same names, same optionality, same enums, same constraints). This is
 * the SHAPE contract validated at ingestion (`POST /v1/agent-events`); any change
 * to the product schema is a coordinated change here. This package validates SHAPE
 * only — it never stores or logs payload content (§15.2). Redaction/truncation/path
 * hashing is CORE-NORMALIZE's job, not this file's.
 */
import { z } from "zod";

import {
  eventTypeSchema,
  harnessSchema,
  isoDateTimeSchema,
  sessionStatusSchema,
} from "./primitives";

/** Machine identity carried on each event (§10.2). `os` is free-form (the adapter reports it). */
export const machineSchema = z.object({
  label: z.string().min(1),
  os: z.string().min(1),
});

/** Workspace context (§10.2). `repo_name`/`branch` are optional ("if available", §8.6). */
export const workspaceSchema = z.object({
  cwd: z.string().min(1),
  repo_name: z.string().optional(),
  branch: z.string().optional(),
});

/** Open-ended event metadata (§10.2): known fields plus any adapter-specific extras. */
export const eventMetadataSchema = z
  .object({
    tool: z.string().optional(),
    command_summary: z.string().optional(),
  })
  .catchall(z.unknown());

/** The canonical agent event payload (§10.2). */
export const birdyBeepAgentEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: eventTypeSchema,
  occurred_at: isoDateTimeSchema,
  harness: harnessSchema,
  harness_version: z.string().optional(),
  source_session_id: z.string().min(1),
  machine: machineSchema,
  workspace: workspaceSchema,
  status: sessionStatusSchema,
  title: z.string(),
  body: z.string(),
  metadata: eventMetadataSchema.optional(),
});

export type Machine = z.infer<typeof machineSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type EventMetadata = z.infer<typeof eventMetadataSchema>;
export type BirdyBeepAgentEvent = z.infer<typeof birdyBeepAgentEventSchema>;

/**
 * The request body for `POST /v1/agent-events` is exactly the canonical event
 * payload (§13.4/§13.5). Aliased so the sender (CORE-SENDER) reads intent clearly.
 */
export const agentEventsRequestSchema = birdyBeepAgentEventSchema;
export type AgentEventsRequest = BirdyBeepAgentEvent;
