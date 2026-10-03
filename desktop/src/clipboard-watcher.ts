import { type CaptureDecision, evaluateCapture } from './policy.js';

export interface ClipboardSnapshot {
  text: string;
  /** Data URL of an image on the clipboard, or null. */
  image?: string | null;
  formats: string[];
}

export type Captured =
  | { kind: 'text'; text: string; potentialSecret: boolean }
  | { kind: 'image'; image: string };

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
  private previousImage: string | null = null;
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
    const image = snapshot.image ?? null;
    const decision = evaluateCapture({
      text: snapshot.text,
      image,
      previousText: this.previousText,
      previousImage: this.previousImage,
      formats: snapshot.formats,
      captureSecrets: this.options.captureSecrets?.() ?? false,
    });

    // Track the latest non-empty clipboard values regardless of the enabled
    // state or the decision, so toggling capture on does not re-capture them.
    if (snapshot.text.trim().length > 0) {
      this.previousText = snapshot.text;
    }
    if (image) {
      this.previousImage = image;
    }

    if (decision.action === 'skip') {
      this.options.onSkip?.(decision);
      return;
    }
    if (!this.options.isEnabled()) {
      return;
    }
    if (decision.kind === 'text') {
      this.options.onCapture({
        kind: 'text',
        text: snapshot.text,
        potentialSecret: decision.potentialSecret,
      });
    } else {
      this.options.onCapture({ kind: 'image', image: image! });
    }
  }
}
