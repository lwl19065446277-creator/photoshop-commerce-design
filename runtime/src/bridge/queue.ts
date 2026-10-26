import { randomUUID } from 'node:crypto';
import type { Command } from '../contracts.js';
import { StudioError } from '../errors.js';

type Pending = { command: Command; delivered: boolean; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };
export class CommandQueue {
  session?: { id: string; pluginVersion: string; photoshopVersion: string; lastSeen: number };
  uncertain = false;
  private pending?: Pending;
  private wake?: () => void;
  private completed = new Set<string>();
  constructor(readonly timeoutMs = 90000, readonly staleMs = 45000) {}
  get connected() { return !!this.session && Date.now() - this.session.lastSeen < this.staleMs; }
  get busy() { return !!this.pending; }
  hello(info: { pluginVersion: string; photoshopVersion: string }) {
    if (this.pending) throw new StudioError('BUSY', 'Cannot replace Photoshop session while a command is pending');
    if (this.connected) throw new StudioError('ALREADY_CONNECTED', 'A plugin session is already connected; disconnect it before reconnecting');
    this.session = { id: randomUUID(), ...info, lastSeen: Date.now() };
    return { sessionId: this.session.id };
  }
  touch(sessionId: string) {
    if (!this.session || sessionId !== this.session.id) throw new StudioError('INVALID_SESSION', 'Reconnect the UXP plugin to this bridge');
    this.session.lastSeen = Date.now();
  }
  disconnect(sessionId: string) {
    this.touch(sessionId);
    if (this.pending) throw new StudioError('BUSY', 'Finish the current Photoshop command before disconnecting');
    this.session = undefined;
    this.wake?.();
  }
  async submit(operation: string, args: Record<string, unknown>, id: string = randomUUID()): Promise<unknown> {
    if (!this.connected) throw new StudioError('PHOTOSHOP_DISCONNECTED', 'No live Photoshop UXP plugin is connected');
    if (this.uncertain) throw new StudioError('EXECUTION_UNCERTAIN', 'A delivered command timed out. Inspect the working copy in Photoshop, then restart bridge and reconnect. No automatic mutation retry is allowed.');
    if (this.pending) throw new StudioError('BUSY', 'Another Photoshop command is in progress');
    return new Promise((resolve, reject) => {
      const command = { id, operation, args };
      const timer = setTimeout(() => {
        if (this.pending?.command.id !== id) return;
        const delivered = this.pending.delivered;
        this.uncertain = delivered;
        this.pending = undefined;
        reject(new StudioError(delivered ? 'EXECUTION_UNCERTAIN' : 'COMMAND_NOT_DELIVERED', delivered ? 'Photoshop may have executed this command. Inspect its working copy before restarting; do not retry blindly.' : 'Plugin did not poll for the command; nothing was delivered.', { commandId: id }));
      }, this.timeoutMs);
      this.pending = { command, delivered: false, resolve, reject, timer };
      this.wake?.();
    });
  }
  async next(sessionId: string, waitMs = 20000): Promise<Command | undefined> {
    this.touch(sessionId);
    if (this.wake) throw new StudioError('POLL_ALREADY_PENDING', 'Only one plugin polling request is permitted');
    if (!this.pending || this.pending.delivered) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, waitMs);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = undefined;
    }
    this.touch(sessionId);
    if (!this.pending || this.pending.delivered) return undefined;
    this.pending.delivered = true;
    return this.pending.command;
  }
  finish(result: { sessionId: string; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } }) {
    this.touch(result.sessionId);
    if (this.completed.has(result.id)) return;
    const pending = this.pending;
    if (!pending || result.id !== pending.command.id || !pending.delivered) throw new StudioError('UNEXPECTED_RESULT', 'Result does not match a delivered command');
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.completed.add(result.id);
    if (this.completed.size > 1000) this.completed.delete(this.completed.values().next().value!);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new StudioError(result.error!.code, result.error!.message, result.error!.details));
  }
  close() {
    this.wake?.();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new StudioError('BRIDGE_STOPPED', 'Bridge stopped during command'));
      this.pending = undefined;
    }
  }
}
