import { distance, instanceKey, validEvent, type BotView, type GameEvent, type Job } from '../core/types.js';
export class Scheduler {
  readonly jobs = new Map<string, Job>();
  constructor(private maxAttempts = 3, private maxJobs = 2000, private retryMs = 5000) {}
  enqueue(event: GameEvent, now: number): boolean {
    if (!validEvent(event) || event.expiresAt <= now || this.jobs.has(event.id)) return false;
    this.prune(now);
    if (this.jobs.size >= this.maxJobs) return false;
    this.jobs.set(event.id, { id: event.id, event: { ...structuredClone(event), instanceId: instanceKey(event.instanceId) }, state: 'QUEUED', attempts: 0, lease: 0, updatedAt: now, availableAt: now }); return true;
  }
  assign(bots: BotView[], now: number): Array<{ job: Job; bot: BotView }> {
    const assignments: Array<{ job: Job; bot: BotView }> = [];
    const reserved = new Set([...this.jobs.values()].filter(j => ['ASSIGNED', 'RUNNING'].includes(j.state)).map(j => j.botId));
    for (const job of [...this.jobs.values()].sort((a, b) => a.event.expiresAt - b.event.expiresAt)) {
      if (job.state !== 'QUEUED' || job.availableAt > now) continue;
      if (job.event.expiresAt <= now) { job.state = 'EXPIRED'; job.updatedAt = now; continue; }
      const candidates = bots.filter(b => b.state === 'IN_PIT_IDLE' && b.instanceId === job.event.instanceId && b.position && !reserved.has(b.id));
      candidates.sort((a, b) => distance(a.position!, job.event.target) - distance(b.position!, job.event.target) || a.id.localeCompare(b.id));
      const bot = candidates[0]; if (!bot) continue;
      job.state = 'ASSIGNED'; job.botId = bot.id; job.attempts++; job.lease++; job.updatedAt = now;
      reserved.add(bot.id); assignments.push({ job, bot });
    }
    return assignments;
  }
  owns(id: string, botId: string, lease: number): boolean {
    const job = this.jobs.get(id);
    return !!job && job.botId === botId && job.lease === lease && ['ASSIGNED', 'RUNNING'].includes(job.state);
  }
  running(id: string, botId: string, lease: number, now: number): boolean {
    if (!this.owns(id, botId, lease)) return false;
    const job = this.jobs.get(id)!; job.state = 'RUNNING'; job.updatedAt = now; return true;
  }
  complete(id: string, botId: string, lease: number, now: number): boolean {
    if (!this.owns(id, botId, lease)) return false;
    const job = this.jobs.get(id)!; job.state = job.event.expiresAt <= now ? 'EXPIRED' : 'COMPLETED'; job.botId = undefined; job.updatedAt = now; return true;
  }
  release(id: string, botId: string, lease: number, now: number): boolean {
    if (!this.owns(id, botId, lease)) return false;
    const job = this.jobs.get(id)!;
    job.state = job.event.expiresAt <= now ? 'EXPIRED' : job.attempts >= this.maxAttempts ? 'FAILED' : 'QUEUED';
    job.botId = undefined; job.lease++; job.updatedAt = now; job.availableAt = now + this.retryMs; return true;
  }
  expire(now: number): Job[] {
    const expired: Job[] = [];
    for (const job of this.jobs.values()) if (!['COMPLETED', 'FAILED', 'EXPIRED'].includes(job.state) && job.event.expiresAt <= now) {
      expired.push({ ...job }); job.state = 'EXPIRED'; job.botId = undefined; job.lease++; job.updatedAt = now;
    }
    this.prune(now); return expired;
  }
  prune(now: number): void {
    // Keep terminal IDs until the event expires so provider repeats cannot re-execute them.
    for (const [id, job] of this.jobs) if (['COMPLETED', 'FAILED', 'EXPIRED'].includes(job.state) && job.event.expiresAt + 60000 < now) this.jobs.delete(id);
  }
  snapshot(): Job[] { return structuredClone([...this.jobs.values()]); }
  restore(jobs: Job[], now: number): void {
    for (const saved of jobs.slice(-this.maxJobs)) {
      if (!validEvent(saved.event) || saved.event.expiresAt <= now) continue;
      const job = structuredClone(saved);
      if (['ASSIGNED', 'RUNNING'].includes(job.state)) { job.state = job.attempts >= this.maxAttempts ? 'FAILED' : 'QUEUED'; job.lease++; job.availableAt = now + this.retryMs; }
      job.botId = undefined; this.jobs.set(job.id, job);
    }
  }
}
