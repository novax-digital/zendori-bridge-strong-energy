'use client';

import { useFormStatus } from 'react-dom';

/**
 * Submit button with pending feedback: while the surrounding form's server
 * action runs, the button disables itself and shows a spinner. Must be
 * rendered INSIDE the <form> it belongs to (useFormStatus contract).
 */

type Variant = 'primary' | 'secondary' | 'danger';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60',
  secondary:
    'rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60',
  danger:
    'rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60',
};

export function SubmitButton({
  children,
  pendingText,
  variant = 'secondary',
  className,
  formAction,
  formNoValidate,
}: {
  children: React.ReactNode;
  /** Optional label shown while pending (defaults to the normal label). */
  pendingText?: string;
  variant?: Variant;
  className?: string;
  /** Per-button server action override (multi-action forms). */
  formAction?: ((formData: FormData) => void | Promise<void>) | string;
  formNoValidate?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      formAction={formAction}
      formNoValidate={formNoValidate}
      className={`inline-flex items-center justify-center gap-2 ${VARIANT_CLASSES[variant]} ${className ?? ''}`}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        className="opacity-90"
      />
    </svg>
  );
}
