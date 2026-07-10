import type { Channel, MessageStatus, TicketPriority } from '@zendori/core';

/**
 * German UI labels for the enums (single source for all dashboard pages)
 * plus the presentational status badge.
 */

export const STATUS_LABELS: Record<MessageStatus, string> = {
  received: 'Eingegangen',
  extracted: 'Extrahiert',
  needs_info: 'Braucht Info',
  ticket_created: 'Ticket erstellt',
  attached_to_existing: 'Angehängt',
  spam: 'Spam',
  failed: 'Fehlgeschlagen',
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'E-Mail',
  form: 'Formular',
  paste: 'Notiz',
  phone: 'Telefon',
  whatsapp: 'WhatsApp',
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Niedrig',
  normal: 'Normal',
  high: 'Hoch',
  urgent: 'Dringend',
};

const STATUS_CLASSES: Record<MessageStatus, string> = {
  received: 'border-zinc-200 bg-zinc-100 text-zinc-700',
  extracted: 'border-blue-200 bg-blue-50 text-blue-700',
  needs_info: 'border-amber-200 bg-amber-50 text-amber-800',
  ticket_created: 'border-green-200 bg-green-50 text-green-700',
  attached_to_existing: 'border-teal-200 bg-teal-50 text-teal-700',
  spam: 'border-gray-200 bg-gray-100 text-gray-500',
  failed: 'border-red-200 bg-red-50 text-red-700',
};

export function StatusBadge({ status }: { status: MessageStatus }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
