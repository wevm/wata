/**
 * Tiny in-page event log shared by the consumer and host playground
 * pages. Compact: one row per entry, time + tag + inline detail preview.
 */

import { useCallback, useState } from 'react'
import { Tag } from 'regen-ui'

/** Color intent for a log entry (maps directly to `Tag` intents). */
export type Intent = 'accent' | 'info' | 'negative' | 'neutral' | 'positive' | 'warning'

/** A single log entry. */
export type Entry = {
  id: number
  time: string
  intent: Intent
  label: string
  /** Optional JSON-RPC request id this entry relates to. */
  requestId?: number | string | undefined
  detail?: unknown | undefined
}

/** Stateful log. */
export type Log = {
  entries: readonly Entry[]
  push: (entry: Omit<Entry, 'id' | 'time'>) => void
  clear: () => void
}

/** Subscribe to a fresh log. */
export function useLog(): Log {
  const [entries, setEntries] = useState<readonly Entry[]>([])

  const push = useCallback<Log['push']>((entry) => {
    setEntries((prev) => [
      {
        ...entry,
        id: nextId(),
        time: new Date().toISOString().slice(11, 19),
      },
      ...prev,
    ])
  }, [])

  const clear = useCallback(() => setEntries([]), [])

  return { entries, push, clear }
}

let counter = 0
function nextId() {
  counter += 1
  return counter
}

const cellClass = 'border-r border-border px-[8px] py-[4px] truncate'
const headerCellClass = `${cellClass} text-foreground bg-secondary font-medium copy-13 text-left`
const bodyCellClass = `${cellClass} copy-13 text-foreground-secondary`

/**
 * Render a `Log` as a Chrome DevTools-style table: dark header row with
 * column dividers, monospaced rows beneath. Columns: Time, Event, Detail.
 */
export function LogView(props: { log: Log }) {
  const { log } = props

  return (
    <div className="overflow-hidden border border-border bg-background">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: '88px' }} />
          <col style={{ width: '60px' }} />
          <col style={{ width: '180px' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className={headerCellClass}>Time</th>
            <th className={headerCellClass}>ID</th>
            <th className={headerCellClass}>Event</th>
            <th className={`${headerCellClass} border-r-0`}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {log.entries.length === 0 ? (
            <tr>
              <td className={`${bodyCellClass} border-r-0 text-foreground-tertiary`} colSpan={4}>
                no events yet
              </td>
            </tr>
          ) : (
            log.entries.map((entry) => (
              <tr key={entry.id}>
                <td className={`${bodyCellClass} tabular-nums`}>{entry.time}</td>
                <td className={`${bodyCellClass} tabular-nums`}>
                  {entry.requestId === undefined ? '' : String(entry.requestId)}
                </td>
                <td className={bodyCellClass}>
                  <Tag intent={entry.intent} dot>
                    {entry.label}
                  </Tag>
                </td>
                <td className={`${bodyCellClass} border-r-0`}>
                  <code className="text-foreground-secondary">
                    {entry.detail === undefined ? '' : preview(entry.detail)}
                  </code>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function preview(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    const json = JSON.stringify(value)
    if (!json) return String(value)
    return json.length > 80 ? `${json.slice(0, 77)}…` : json
  } catch {
    return String(value)
  }
}
