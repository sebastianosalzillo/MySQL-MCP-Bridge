import crypto from 'node:crypto';

export class ApprovalManager {
  constructor(onApproval = () => {}) {
    this.items = new Map();
    this.onApproval = onApproval;
  }

  request({ action, summary, sql }) {
    const id = crypto.randomUUID();
    const item = {
      id,
      action,
      summary,
      sql: sql || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 5 * 60_000
    };
    this.items.set(id, item);
    this.onApproval(this.publicItem(item));
    return id;
  }

  get(id) {
    this.cleanup();
    const item = this.items.get(id);
    return item ? this.publicItem(item) : null;
  }

  decide(id, approved) {
    const item = this.items.get(id);
    if (!item || item.expiresAt < Date.now()) return false;
    item.status = approved ? 'approved' : 'denied';
    item.decidedAt = new Date().toISOString();
    return true;
  }

  consume(id, action) {
    const item = this.items.get(id);
    if (!item || item.expiresAt < Date.now() || item.action !== action) return false;
    if (item.status !== 'approved') return false;
    this.items.delete(id);
    return true;
  }

  list() {
    this.cleanup();
    return [...this.items.values()].map(x => this.publicItem(x));
  }

  cleanup() {
    const now = Date.now();
    for (const [id, item] of this.items) if (item.expiresAt < now) this.items.delete(id);
  }

  publicItem(item) {
    const { expiresAt, ...rest } = item;
    return { ...rest, expiresAt: new Date(expiresAt).toISOString() };
  }
}
