import z from 'zod';
import { assertRequiredParams, GremlinApi, wrapGremlinError } from '../client/gremlin';

const teamIdSchema = z.string().describe(
  "The team identifier. Use the list_teams tool to find available teams and match by name or ID."
);

export function createGetContainerTool(api: GremlinApi) {
  return {
    name: 'get_container',
    description: [
      'Fetches a single container by its ID — a quick point lookup, not a search.',
      "Returns the container's id, clientId, name, and labels.",
    ].join(' '),
    annotations: { readOnlyHint: true },
    schema: {
      teamId: teamIdSchema,
      containerId: z.string().describe('The ID of the container to look up.'),
    },
    handler: async (args: { teamId: string; containerId: string }) => {
      const { teamId, containerId } = args;
      assertRequiredParams(
        Boolean(teamId) && Boolean(containerId),
        `got ${JSON.stringify(args)} but expected { teamId: string, containerId: string }`,
      );

      try {
        return await api.getContainer(containerId, teamId);
      } catch (error) {
        throw wrapGremlinError('Failed to fetch container', error);
      }
    },
  };
}

export function createMatchContainersTool(api: GremlinApi) {
  return {
    name: 'match_containers',
    description: [
      'Previews which of the team\'s containers a targeting selector would match, using the',
      'same matching logic a real Service\'s targeting strategy uses — so this shows exactly',
      'what a Service would target, without creating one.',
      'Exactly one of isAll, ids, or multiSelectLabels must be set:',
      'isAll matches every container for the team;',
      'ids matches containers whose id is in the given list;',
      'multiSelectLabels matches by label, where each key maps to a list of acceptable values',
      '(keys are combined with AND, values within a key with OR).',
      'Use list_container_label_keys first to discover valid label keys for multiSelectLabels.',
      'Returns matchedContainers plus totalContainerCount (the full team container count, so',
      'you can report e.g. "12 of 340 matched").',
    ].join(' '),
    annotations: { readOnlyHint: true },
    schema: {
      teamId: teamIdSchema,
      isAll: z.boolean().optional().describe(
        'Match every container for the team. Mutually exclusive with ids and multiSelectLabels.',
      ),
      ids: z.array(z.string()).optional().describe(
        'Match containers whose id is in this list. Mutually exclusive with isAll and multiSelectLabels.',
      ),
      multiSelectLabels: z.record(z.array(z.string())).optional().describe(
        'Match containers by label: each key maps to a list of acceptable values for that key. ' +
        'A container matches only if every key is present with one of the listed values ' +
        '(keys combined with AND, values within a key combined with OR). ' +
        'Mutually exclusive with isAll and ids.',
      ),
    },
    handler: async (args: { teamId: string; isAll?: boolean; ids?: string[]; multiSelectLabels?: Record<string, string[]> }) => {
      const { teamId, isAll, ids, multiSelectLabels } = args;
      assertRequiredParams(
        Boolean(teamId),
        `got ${JSON.stringify(args)} but expected { teamId: string, ... }`,
      );

      const fieldsSet = [isAll !== undefined, ids !== undefined, multiSelectLabels !== undefined]
        .filter(Boolean).length;
      assertRequiredParams(
        fieldsSet === 1,
        `Exactly one of isAll, ids, or multiSelectLabels must be set. got ${JSON.stringify(args)}`,
      );

      try {
        return await api.matchContainers(teamId, { isAll, ids, multiSelectLabels });
      } catch (error) {
        throw wrapGremlinError('Failed to preview container match', error);
      }
    },
  };
}

export function createListContainerLabelKeysTool(api: GremlinApi) {
  return {
    name: 'list_container_label_keys',
    description: [
      "Lists the distinct label keys observed across all of the team's containers",
      '(keys only — no values or counts).',
      'Use this to discover what label keys are available before building a',
      'multiSelectLabels selector for match_containers.',
    ].join(' '),
    annotations: { readOnlyHint: true },
    schema: {
      teamId: teamIdSchema,
    },
    handler: async (args: { teamId: string }) => {
      const { teamId } = args;
      assertRequiredParams(Boolean(teamId), `got ${JSON.stringify(args)} but expected { teamId: string }`);

      try {
        return await api.getContainerLabelKeys(teamId);
      } catch (error) {
        throw wrapGremlinError('Failed to fetch container label keys', error);
      }
    },
  };
}
