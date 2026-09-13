import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui class merge helper. Used by ElevenLabs UI components. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
