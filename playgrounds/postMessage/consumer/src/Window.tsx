/**
 * macOS-style window chrome used to frame the consumer and host panes.
 * Pure presentation: traffic-light dots on the left, centered title bar
 * with optional subtitle (status pill, etc.), and a flex body that fills
 * the remaining space.
 */

import type { ReactNode, Ref } from 'react'

export type Props = {
  /** Title shown centered in the title bar. */
  title: string
  /** Optional content rendered next to the title (e.g. a state pill). */
  subtitle?: ReactNode | undefined
  /** Body content. */
  children: ReactNode
  /** Class name(s) applied to the outer chrome element. */
  className?: string | undefined
  /** Ref to the outer chrome `<div>` (used by the consumer to align popups). */
  ref?: Ref<HTMLDivElement> | undefined
}

export function Window(props: Props) {
  const { title, subtitle, children, className, ref } = props

  return (
    <div
      ref={ref}
      className={[
        'flex flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[0_18px_40px_-18px_rgba(0,0,0,0.7),_0_2px_4px_rgba(0,0,0,0.4)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="relative flex items-center border-b border-border bg-secondary px-[12px] py-[8px]">
        <span className="flex gap-[6px]" aria-hidden>
          <span className="h-[12px] w-[12px] rounded-full bg-[#ff5f57]" />
          <span className="h-[12px] w-[12px] rounded-full bg-[#febc2e]" />
          <span className="h-[12px] w-[12px] rounded-full bg-[#28c840]" />
        </span>
        <span className="absolute left-1/2 -translate-x-1/2 inline-flex items-center gap-[8px] copy-13 font-medium text-foreground">
          {title}
          {subtitle}
        </span>
      </header>
      <div className="flex flex-1 min-h-0 flex-col">{children}</div>
    </div>
  )
}
