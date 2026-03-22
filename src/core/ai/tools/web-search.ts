import { registerTool, type AITool } from './registry'
import { getSolPrefix } from '../soul'

/**
 * Web Search tool — searches the web and answers with citations.
 *
 * Unlike other tools, this one requires a two-step process:
 * 1. Search the web (async, done before prompt construction)
 * 2. Inject results into the LLM prompt
 *
 * Because buildPrompt is synchronous, the search results must be
 * passed via the ToolParams.entities hack — the caller pre-fetches
 * search results and injects them as a special entity.
 *
 * In practice, the Lyra chat handles this via the /search command
 * which calls webSearch() first, then passes results to the tool.
 */
const tool: AITool = {
  id: 'web-search',
  name: 'Web Search',
  description: 'Search the web and answer with sources',
  scope: 'global',
  buildPrompt: ({ entities }) => {
    // The search results are injected into entities as a special marker
    // by the caller (lyra-chat or useAI). Look for it in the first entity's metadata.
    const searchEntity = entities.find((e) => e.id === '__web-search-results__')
    const searchContext = (searchEntity?.description as string) ?? 'No web results available.'
    const query = searchEntity?.title ?? 'web search'

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(200),
          '',
          'The user asked a question that requires web knowledge.',
          'Web search results are provided below. Answer based on these results.',
          'Cite sources with [1], [2], etc. Be concise and factual.',
          'If results are insufficient, say so honestly.',
          '',
          '## Web Search Results:',
          searchContext,
        ].join('\n'),
      },
      { role: 'user', content: query },
    ]
  },
}

registerTool(tool)
