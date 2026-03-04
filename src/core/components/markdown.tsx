interface MarkdownProps {
  content: string
  className?: string
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  // Pattern: **bold**, *italic*, `code`, [text](url)
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    if (match[1]) {
      nodes.push(<strong key={match.index}>{match[2]}</strong>)
    } else if (match[3]) {
      nodes.push(<em key={match.index}>{match[4]}</em>)
    } else if (match[5]) {
      nodes.push(
        <code key={match.index} className="bg-muted px-1 py-0.5 rounded text-[0.85em]">
          {match[6]}
        </code>,
      )
    } else if (match[7]) {
      nodes.push(
        <a
          key={match.index}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          {match[8]}
        </a>,
      )
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes.length > 0 ? nodes : [text]
}

export function Markdown({ content, className }: MarkdownProps) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let listItems: string[] = []

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${elements.length}`} className="list-disc list-inside space-y-0.5">
          {listItems.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      listItems = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const listMatch = line.match(/^[-*]\s+(.+)/)
    if (listMatch) {
      listItems.push(listMatch[1])
    } else {
      flushList()
      if (line.trim() === '') {
        continue
      }
      elements.push(
        <p key={`p-${i}`}>{renderInline(line)}</p>,
      )
    }
  }
  flushList()

  return <div className={`space-y-1.5 text-sm ${className ?? ''}`}>{elements}</div>
}
