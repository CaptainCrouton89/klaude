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
    // Env var was set but doesn't match any running instance
    const availableList = candidates.map((c) => c.instanceId).join(', ');
    const availableInfo = availableList.length > 0 ? availableList : 'none running';
    throw new KlaudeError(
      `Instance ${envInstanceId} from KLAUDE_INSTANCE_ID env var is not running. ` +
      `Available instances: ${availableInfo}. ` +
      `Start a new wrapper with \`klaude\` or specify instance explicitly with --instance`,
      'E_INSTANCE_NOT_FOUND',
    );
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new KlaudeError(
      'No running wrapper instances for this project. Start one with `klaude`.',
      'E_INSTANCE_NOT_FOUND',
    );
  }

  const availableList = candidates.map((c) => c.instanceId).join(', ');
  throw new KlaudeError(
    `Multiple instances available; specify one with --instance. Available: ${availableList}`,
    'E_AMBIGUOUS_INSTANCE',
  );
}
