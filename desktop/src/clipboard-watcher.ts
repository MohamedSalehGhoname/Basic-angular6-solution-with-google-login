import { type CaptureDecision, evaluateCapture } from './policy.js';

export interface ClipboardSnapshot {
  text: string;
  formats: string[];
}

export interface Captured {
  text: string;
  potentialSecret: boolean;
}

export interface WatcherOptions {
  /** Reads the current clipboard text and formats (may be async). */
  read: () => ClipboardSnapshot | Promise<ClipboardSnapshot>;
  /** Called for each value that passes the policy. */
  onCapture: (captured: Captured) => void;
  /** Optional hook for skipped values (diagnostics/telemetry). */
  onSkip?: (decision: Extract<CaptureDecision, { action: 'skip' }>) => void;
  /** Whether capturing is currently enabled (checked on every poll). */
  isEnabled: () => boolean;
  /** Whether values that look like secrets should be captured (default false). */
  captureSecrets?: () => boolean;
  pollIntervalMs?: number;
}

/**
 * Polls the OS clipboard (Electron exposes no change event) and forwards new
 * values that pass the capture policy. The last seen text is remembered even
 * while capture is disabled, so re-enabling does not replay whatever is
 * already on the clipboard.
 */
export class ClipboardWatcher {
  private readonly pollIntervalMs: number;
  private previousText: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: WatcherOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 800;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one poll cycle; exposed for tests. */
  async poll(): Promise<void> {
    const snapshot = await this.options.read();
    const decision = evaluateCapture({
      text: snapshot.text,
      previousText: this.previousText,
      formats: snapshot.formats,
      captureSecrets: this.options.captureSecrets?.() ?? false,
    });

    // Track the latest non-empty clipboard value regardless of the enabled
    // state or the decision, so toggling capture on does not re-capture it.
    if (snapshot.text.trim().length > 0) {
      this.previousText = snapshot.text;
    }

    if (decision.action === 'skip') {
      this.options.onSkip?.(decision);
      return;
    }
    if (!this.options.isEnabled()) {
      return;
    }
    this.options.onCapture({ text: snapshot.text, potentialSecret: decision.potentialSecret });
  }
}
