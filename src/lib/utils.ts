import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Whether a keypress belongs to a text field rather than to the app's shortcuts.
 *
 * There were three copies of this and they disagreed: one knew about `<select>` and not
 * contenteditable, the other two the reverse — so `j` moved a list while you typed in a rich-text
 * note, and `g` armed navigation inside a dropdown. The union of all three is the rule.
 */
export function isTypingTarget(target: EventTarget | Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
