import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ElicitationOption {
  label: string;
  value: string;
  description?: string;
}

/**
 * Abstracts over any mechanism that asks a user to pick from a set of options.
 * Implement this to plug custom confirmation UIs into the Gremlin tools.
 */
export interface ElicitationClient {
  /**
   * Prompt the user to choose one of the provided options.
   * Returns the `value` of the chosen option.
   * Throw if the prompt cannot be shown (e.g. unsupported runtime).
   */
  confirm(prompt: string, options: ElicitationOption[]): Promise<string>;
}

/**
 * Adapter that implements ElicitationClient on top of the MCP SDK's elicitInput.
 * Maps the options array to a string enum field so MCP clients can render all choices.
 * When the user dismisses the dialog without selecting, falls back to the last option.
 */
export class McpElicitationClient implements ElicitationClient {
  constructor(private readonly server: McpServer) {}

  async confirm(prompt: string, options: ElicitationOption[]): Promise<string> {
    const fallback = options[options.length - 1]?.value ?? options[0].value;

    const result = await this.server.server.elicitInput({
      message: prompt,
      requestedSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'string',
            title: 'Select an action',
            enum: options.map(o => o.value),
            description: options.map(o => `${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n'),
          },
        },
        required: ['choice'],
      },
    });

    if (result.action === 'accept' && typeof result.content?.['choice'] === 'string') {
      return result.content['choice'];
    }
    return fallback;
  }
}
