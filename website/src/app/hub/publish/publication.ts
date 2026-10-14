import { communityRequest } from '@/lib/community/client';
import { noEnglish } from '@/lib/community/translation';
import type { HarnessSnapshot, OpenHarness } from '@/lib/community/types';
import type { PublishDraft } from './usePublishDraft';

const review = { confirmed: true, license: 'MIT' } as const;

/** What the Hub stores: the draft without the note that was only for the person reviewing it. */
export function toSnapshot(draft: PublishDraft): HarnessSnapshot {
  const { title, description, category, engine, harnessId, files, viewerPath, conversation, cover, forkedFrom } = draft;
  return { title, description, category, engine, ...(harnessId ? { harnessId } : {}), files, viewerPath, conversation, ...(cover ? { cover } : {}), ...(forkedFrom ? { forkedFrom } : {}) };
}

/** One of your publications as a draft to edit: what it shows now, saved back to the same address. */
export async function editDraft(id: string): Promise<PublishDraft> {
  const { harness } = await communityRequest<{ harness: OpenHarness | null }>(`harnesses/${id}`);
  if (!harness) throw new Error('This harness is unavailable.');
  const { title, description, category, engine, harnessId, files, viewerPath, conversation, forkedFrom } = harness;
  // The cover stays as it is unless a new one is chosen: what a reader gets is its address, not its bytes.
  return { title, description, category, engine, harnessId, files, viewerPath, conversation, forkedFrom, contextNote: '', english: noEnglish, updateId: id };
}

/**
 * Publishes the draft, or saves it over the publication it updates, and returns the publication's id.
 * An update keeps where the publication came from, and its cover unless a new one was chosen.
 */
export async function submitPublication(draft: PublishDraft, clientId: string | undefined): Promise<string> {
  if (!draft.updateId) return (await communityRequest<{ id: string }>('harnesses', { method: 'POST', body: { ...toSnapshot(draft), ...review, clientId } })).id;
  const { forkedFrom: _forkedFrom, cover, ...edit } = toSnapshot(draft);
  await communityRequest(`harnesses/${draft.updateId}`, { method: 'PUT', body: { ...edit, ...(cover?.startsWith('data:') ? { cover } : {}), ...review } });
  return draft.updateId;
}

/** Takes your publication off the Hub. Forks people already made keep their copy. */
export async function unpublishPublication(id: string): Promise<void> {
  await communityRequest(`harnesses/${id}`, { method: 'DELETE' });
}

/** Your own publications, to choose one a draft updates. */
export async function myPublications(): Promise<{ id: string; title: string }[]> {
  const { harnesses } = await communityRequest<{ harnesses: { id: string; title: string }[] }>('harnesses?mine=true');
  return harnesses.map(({ id, title }) => ({ id, title }));
}
