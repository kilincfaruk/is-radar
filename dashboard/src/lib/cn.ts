/** shadcn/ui class helper: clsx for conditionals, tailwind-merge so later utilities win over earlier ones. */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
