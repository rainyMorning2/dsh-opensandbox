import { pathToFileURL } from 'node:url'
const { LlmAdapter, ToolCallId } = await import(pathToFileURL(`${process.env.DSH_SOURCE_REPO}/packages/llm/llm/src/index.ts`).href)
import { scenario } from './scenarios.mjs'
class ProbeAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{id:'off',name:'Off'}], defaultEffort:'off' } } }
  async *stream(options) {
    const text = options.messages.filter(m => m.role === 'user').flatMap(m => m.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
    const label = text.includes('PROBE_SESSION_b') ? 'b' : 'a'
    const index = options.messages.filter(m => m.role === 'tool').length
    const step = scenario(label)[index]
    if (!step) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Finished session ${label}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const id = ToolCallId(`probe-${label}-${index}`), args = JSON.stringify(step.arguments)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['sandbox-probe'], new ProbeAdapter()) }
