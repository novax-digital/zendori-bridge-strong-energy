import type { Channel } from './types.js';

/**
 * Target-system abstraction (CLAUDE.md §5): the pipeline talks to a TicketSink,
 * never to HubSpot directly. v1 ships HubSpotSink; a future ZendoriSink implements
 * the same interface without touching adapters or pipeline.
 */

export interface ContactInput {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export interface SinkContactRef {
  /** ID in the target system (e.g. HubSpot contact ID). */
  sinkContactId: string;
}

export interface TicketDraft {
  /** Our stable reference, e.g. ZV1-0042 — also the idempotency anchor in the sink. */
  ticketRef: string;
  subject: string;
  description: string;
  category: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  sourceChannel: Channel;
}

export interface SinkTicketRef {
  /** ID in the target system (e.g. HubSpot ticket ID). */
  sinkTicketId: string;
}

export interface NoteInput {
  /** Full text of the follow-up message plus source channel context. */
  body: string;
  sourceChannel: Channel;
  occurredAt: string;
}

export interface SinkHealth {
  ok: boolean;
  detail: string;
}

export interface SinkContext {
  correlationId: string;
}

export interface TicketSink {
  /** Find-or-create a contact; implementations must be idempotent. */
  upsertContact(contact: ContactInput, ctx: SinkContext): Promise<SinkContactRef>;
  /** Create a ticket associated with the contact; must be idempotent on ticketRef. */
  createTicket(
    draft: TicketDraft,
    contact: SinkContactRef,
    ctx: SinkContext,
  ): Promise<SinkTicketRef>;
  /** Attach a follow-up message as a note to an existing ticket. */
  attachNote(ticket: SinkTicketRef, note: NoteInput, ctx: SinkContext): Promise<void>;
  /** Exact lookup by our ticketRef (idempotency check before create). */
  findTicketByRef(ticketRef: string, ctx: SinkContext): Promise<SinkTicketRef | null>;
  /** Startup check: token valid, required scopes present, pipeline reachable. */
  healthCheck(): Promise<SinkHealth>;
}
