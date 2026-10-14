import styles from '../../community.module.css';

/** Below an edit, the one way to take the harness off the Hub, asked twice. */
export function UnpublishAction({ busy, onUnpublish }: { busy: boolean; onUnpublish: () => void }) {
  const confirmThen = () => {
    if (window.confirm('Remove this harness from the public feed? Forks people already made keep their copy.')) onUnpublish();
  };
  return <div className={styles.manage}><button type="button" disabled={busy} onClick={confirmThen}>Unpublish this harness</button></div>;
}
