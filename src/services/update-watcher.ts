import { listPendingUpdatesByParent, markUpdateAcknowledged } from '@/db/index.js';
import type { AgentUpdate } from '@/types/db.js';

export interface UpdateWatcherOptions {
  parentSessionId: string;
  filter?: RegExp;
  onUpdate: (update: AgentUpdate) => void | Promise<void>;
  acknowledgeOnProcess?: boolean;
  pollIntervalMs?: number;
}

interface WatcherState {
  running: boolean;
  lastSeenId: number;
  intervalHandle: NodeJS.Timeout | null;
}

export class UpdateWatcher {
  private state: WatcherState;
  private options: UpdateWatcherOptions;

  constructor(options: UpdateWatcherOptions) {
    this.options = options;
    this.state = {
      running: false,
      lastSeenId: 0,
      intervalHandle: null,
    };
  }

  /**
   * Start polling for updates
   */
  start(): void {
    if (this.state.running) {
      return;
    }

    this.state.running = true;
    const pollInterval = this.options.pollIntervalMs ?? 3000;

    // Poll immediately on start
    void this.poll();

    // Then poll at interval
    this.state.intervalHandle = setInterval(() => {
      void this.poll();
    }, pollInterval);
  }

  /**
   * Stop polling for updates
   */
  stop(): void {
    if (!this.state.running) {
      return;
    }

    this.state.running = false;
    if (this.state.intervalHandle !== null) {
      clearInterval(this.state.intervalHandle);
      this.state.intervalHandle = null;
    }
  }

  /**
   * Check for new updates
   */
  private async poll(): Promise<void> {
    if (!this.state.running) {
      return;
    }

    try {
      const updates = listPendingUpdatesByParent(this.options.parentSessionId);

      // Filter for new updates
      const newUpdates = updates.filter((u) => u.id > this.state.lastSeenId);

      // Apply regex filter if specified
      const filteredUpdates = this.options.filter
        ? newUpdates.filter((u) => this.options.filter!.test(u.update_text))
        : newUpdates;

      // Process each update
      for (const update of filteredUpdates) {
        try {
          // Call handler
          await this.options.onUpdate(update);

          // Mark as acknowledged if requested
          if (this.options.acknowledgeOnProcess) {
            markUpdateAcknowledged(update.id);
          }

          // Update last seen ID
          this.state.lastSeenId = update.id;
        } catch (error) {
          // Handler error - log but continue processing other updates
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[UpdateWatcher] Handler error: ${errMsg}`);
        }
      }
    } catch (error) {
      // Poll error - log but continue running
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[UpdateWatcher] Poll error: ${errMsg}`);
    }
  }
}

/**
 * Create and return a new UpdateWatcher instance
 */
export function createUpdateWatcher(options: UpdateWatcherOptions): UpdateWatcher {
  return new UpdateWatcher(options);
}
