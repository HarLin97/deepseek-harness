/**
 * Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
 * becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
 * Assistant reasoning is replayed as `reasoning_content` only on tool-call turns, as required by
 * thinking-mode passback. User and tool messages carrying images become OpenAI-compatible
 * `content` part arrays (`text` + `image_url` base64 data URLs) when the adapter supplied resolved
 * image bytes; an image block whose bytes were never resolved is rejected explicitly rather than
 * silently dropped, and images remain unsupported in system/assistant messages. Unknown
 * declaration-merged block types retain the adapter's documented extension fallback.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { WireContentPart, WireImagePart, WireMessage, WireRequest, WireTool } from './types.ts'

/**
 * Base64 payloads for stored images, keyed by their durable attachment id. The
 * adapter resolves every image block in a request into this map before
 * serialization; `serializeMessages` rejects an image it cannot find here.
 */
export type ImageDataUrls = ReadonlyMap<AttachmentId, string>

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'high' | 'max'
}

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'low' || effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for system and assistant content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject a core image that has no wire representation on this message role. */
function rejectImages(blocks: readonly ContentBlock[], role: 'system' | 'assistant'): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      `The DeepSeek chat-completions adapter cannot represent an image in a ${role} message.`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** The `image_url` wire part for one image block; its bytes must have been resolved. */
function imagePart(block: Extract<ContentBlock, { type: 'image' }>, imageDataUrls: ImageDataUrls | undefined): WireImagePart {
  const base64 = imageDataUrls?.get(block.attachment.attachmentId)
  if (base64 === undefined) {
    throw new LlmError(
      'The DeepSeek chat-completions adapter cannot resolve image bytes without the durable attachment service.',
      'UNSUPPORTED_CONTENT',
    )
  }
  return { type: 'image_url', image_url: { url: `data:${block.attachment.mediaType};base64,${base64}` } }
}

/**
 * Serialize user-visible blocks into wire content. Text-only content collapses
 * to the joined string (the wire string form); image-bearing content becomes
 * an ordered part array, so interleaved text keeps its position. Merge-
 * extensible block types carry no wire representation and are skipped.
 */
function userContent(
  blocks: readonly ContentBlock[],
  imageDataUrls: ImageDataUrls | undefined,
): string | WireContentPart[] {
  const parts: WireContentPart[] = []
  let pending = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        pending += block.text
        break
      case 'image':
        if (pending.length > 0) {
          parts.push({ type: 'text', text: pending })
          pending = ''
        }
        parts.push(imagePart(block, imageDataUrls))
        break
      default:
        break
    }
  }
  if (parts.length === 0) return pending
  if (pending.length > 0) parts.push({ type: 'text', text: pending })
  return parts
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // Official passback rule (guides/thinking_mode.mdx): reasoning_content
    // must return on tool-call turns; it is ignored on plain turns, so we
    // drop it there to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after. Images anywhere in user
 * content (including nested inside tool results) become `image_url` parts
 * resolved from {@link ImageDataUrls}.
 * @param messages - the harness conversation, in order.
 * @param imageDataUrls - resolved base64 payloads for the request's image blocks.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(
  messages: Message[],
  imageDataUrls?: ImageDataUrls,
): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      rejectImages(message.content, 'system')
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      rejectImages(message.content, 'assistant')
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = userContent(message.content, imageDataUrls)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      const content = userContent(result.content, imageDataUrls)
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: typeof content === 'string' ? content || '(no output)' : content,
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @param imageDataUrls - resolved base64 payloads for the request's image blocks.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  imageDataUrls?: ImageDataUrls,
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages, imageDataUrls))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
  const resolvedThinking = resolveThinking(options, defaults)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
