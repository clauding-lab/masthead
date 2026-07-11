import Button from './ui/Button';
import Icon from './ui/Icon';

export default function RefreshButton({ isLoading, onClick }) {
  return (
    <Button
      variant="icon"
      onClick={onClick}
      disabled={isLoading}
      aria-label="Refresh feeds"
      style={{ color: isLoading ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
    >
      <Icon name="refresh" className={isLoading ? 'animate-spin' : ''} />
    </Button>
  );
}
