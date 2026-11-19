import { describe, expect, it } from 'vitest';
import { MeetingOutbox } from './meeting-outbox.js';
import { MemoryMeetingStore, draft } from './meeting-test-store.js';

describe('MeetingOutbox durability state machine (adapter test)', () => {
  it('reloads the permanent warning after its initial metadata read fails', async () => {
    const store = new MemoryMeetingStore();
    const first = new MeetingOutbox(store, 1000);
    const event = draft('x'.repeat(1000));
    first.enqueue(event);
    await first.flushToDisk();
    const reopened = new MeetingOutbox(store);
    const read = store.readLosses.bind(store);
    store.readLosses = async () => {
      throw new Error('blocked');
    };
    await expect(reopened.selectMeeting(event.meetingId)).rejects.toThrow('blocked');
    store.readLosses = read;
    await reopened.flushToDisk();
    expect(reopened.getStatus()).toMatchObject({ lostCount: 1, error: 'memory_limit' });
  });
  it('retains loss counts across storage recovery and reopen without charging another meeting', async () => {
    const store = new MemoryMeetingStore();
    const outbox = new MeetingOutbox(store, 1000);
    await outbox.initialize();
    const event = draft('x'.repeat(1000));
    await outbox.selectMeeting(event.meetingId);
    store.fail = true;
    outbox.enqueue(event);
    outbox.enqueue({ ...event, eventId: crypto.randomUUID() });
    await expect(outbox.flushToDisk()).rejects.toThrow('quota');
    store.fail = false;
    await outbox.flushToDisk();
    await outbox.flushToDisk();
    const reopened = new MeetingOutbox(store);
    await reopened.initialize();
    await reopened.selectMeeting(event.meetingId);
    expect(reopened.getStatus()).toMatchObject({ lostCount: 2, error: 'memory_limit' });
    expect(await reopened.lossGaps(event.meetingId)).toMatchObject([
      { meetingId: event.meetingId, storageLoss: { lostCount: 2 } },
    ]);
    await reopened.selectMeeting(crypto.randomUUID());
    expect(reopened.getStatus()).toMatchObject({ lostCount: 0, unsavedSince: null });
    expect(await reopened.lossGaps(event.meetingId)).toHaveLength(1);
  });
  it('does not lose an additional overflow that arrives while its loss marker commits', async () => {
    const store = new MemoryMeetingStore();
    const outbox = new MeetingOutbox(store, 1000);
    await outbox.initialize();
    const event = draft('x'.repeat(1000));
    const saveLoss = store.saveLoss.bind(store);
    let inject = true;
    store.saveLoss = async (gap) => {
      await saveLoss(gap);
      if (inject) {
        inject = false;
        outbox.enqueue(event);
      }
    };
    outbox.enqueue(event);
    await outbox.flushToDisk();
    expect((await outbox.lossGaps(event.meetingId)).map((g) => g.storageLoss.lostCount)).toEqual([
      2,
    ]);
    expect(await store.readLosses(event.meetingId)).toMatchObject([
      { storageLoss: { lostCount: 2 } },
    ]);
  });
  it('does not dispatch RAM events until durable append completes, and freezes caller data', async () => {
    const store = new MemoryMeetingStore();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const append = store.append.bind(store);
    store.append = async (e) => {
      await gate;
      return append(e);
    };
    const outbox = new MeetingOutbox(store);
    await outbox.initialize();
    const event = draft();
    outbox.enqueue(event);
    event.payload = {
      ...event.payload,
      kind: 'transcript',
      text: 'mutated',
    } as typeof event.payload;
    expect(await outbox.readBatch()).toEqual([]);
    finish();
    await outbox.flushToDisk();
    expect((await outbox.readBatch())[0]!.payload).toMatchObject({ text: 'hello' });
    expect(outbox.getStatus().pendingCount).toBe(1);
  });
  it('keeps pending records after quota failure and retries without changing event ID', async () => {
    const store = new MemoryMeetingStore();
    store.fail = true;
    const outbox = new MeetingOutbox(store);
    await outbox.initialize();
    const event = draft();
    outbox.enqueue(event);
    await expect(outbox.flushToDisk()).rejects.toThrow('quota');
    expect(outbox.getStatus()).toMatchObject({
      pendingCount: 1,
      error: 'local_storage_unavailable',
    });
    store.fail = false;
    await outbox.flushToDisk();
    expect(store.events[0]!.eventId).toBe(event.eventId);
  });
  it('refuses mismatched receipts and only deletes explicitly committed batch IDs', async () => {
    const store = new MemoryMeetingStore();
    const outbox = new MeetingOutbox(store);
    await outbox.initialize();
    outbox.enqueue(draft());
    await outbox.flushToDisk();
    const batch = await outbox.readBatch();
    await expect(
      outbox.acknowledge(batch, {
        meetingId: batch[0]!.meetingId,
        committedEventIds: [],
        committedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    expect(store.events).toHaveLength(1);
    await outbox.acknowledge(batch, {
      meetingId: batch[0]!.meetingId,
      committedEventIds: [batch[0]!.eventId],
      committedAt: new Date().toISOString(),
    });
    expect(outbox.getStatus().pendingCount).toBe(0);
  });
  it('bounds RAM and exposes the unsaved interval instead of silently dropping', async () => {
    const store = new MemoryMeetingStore();
    store.fail = true;
    const outbox = new MeetingOutbox(store, 1000);
    await outbox.initialize();
    outbox.enqueue(draft('x'.repeat(1000)));
    expect(outbox.getStatus()).toMatchObject({
      lostCount: 1,
      error: 'memory_limit',
      pendingCount: 0,
    });
    expect(outbox.getStatus().unsavedSince).toBeTruthy();
    expect(outbox.getStatus().memoryBytes).toBeLessThanOrEqual(1000);
  });
  it('recovers all IDB pending events independently of caption history', async () => {
    const store = new MemoryMeetingStore();
    await store.append(draft());
    const outbox = new MeetingOutbox(store);
    await outbox.initialize();
    expect(outbox.getStatus().pendingCount).toBe(1);
    expect(await outbox.readBatch()).toHaveLength(1);
  });
});
