'use client';
import { rememberHubReturn } from '@/lib/community/session';
import type { SocialState } from '@/lib/community/types';
import { webAppPath } from '@/lib/webApp';
import { useSignedIn } from './useSignedIn';
import styles from '../community.module.css';

type Props = { social: SocialState; ready: boolean; failed: boolean; onRetry: () => void };

/**
 * Why a harness page may read as a visitor's: its likes, comments and the author's Edit could not be
 * loaded, or this browser still holds a sign-in the Hub no longer accepts (it then reads anonymously).
 */
export function DetailNotice({ social, ready, failed, onRetry }: Props) {
  const signedInHere = useSignedIn();
  if (failed) return <p className={styles.notice} role="status">Likes, comments and your own actions could not be loaded.<button type="button" onClick={onRetry}>Retry</button></p>;
  if (ready && signedInHere && !social.signedIn) return <p className={styles.notice} role="status">Your sign-in has expired, so this page reads as a visitor&apos;s.<a href={webAppPath} onClick={rememberHubReturn}>Sign in again</a></p>;
  return null;
}
