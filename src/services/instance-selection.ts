import type { ProjectContext } from '@/services/project-context.js';
import { listInstances } from '@/services/instance-registry.js';
import type { InstanceRegistryEntry } from '@/services/instance-registry.js';
import { KlaudeError } from '@/utils/error-handler.js';

interface ResolveInstanceOptions {
  instanceId?: string;
  allowEnded?: boolean;
  envInstanceId?: string | null;
}

export async function resolveInstanceForProject(
  context: ProjectContext,
  options: ResolveInstanceOptions = {},
): Promise<InstanceRegistryEntry> {
  const instances = await listInstances(context);

  if (instances.length === 0) {
    throw new KlaudeError(
      'No wrapper instances registered for this project. Start one with `klaude`.',
      'E_INSTANCE_NOT_FOUND',
    );
  }

  const envInstanceId = options.envInstanceId ?? process.env.KLAUDE_INSTANCE_ID ?? null;

  const filterRunning = (entry: typeof instances[number]) =>
    options.allowEnded ? true : entry.endedAt === null;

  const candidates = instances.filter(filterRunning);

  if (options.instanceId) {
    const match = candidates.find((entry) => entry.instanceId === options.instanceId);
    if (!match) {
      throw new KlaudeError(
        `Instance ${options.instanceId} not found or not running`,
        'E_INSTANCE_NOT_FOUND',
      );
    }
    return match;
  }

  if (envInstanceId) {
    const match = candidates.find((entry) => entry.instanceId === envInstanceId);
    if (match) {
      return match;
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  throw new KlaudeError(
    'Multiple instances available; specify one with --instance',
    'E_AMBIGUOUS_INSTANCE',
  );
}
