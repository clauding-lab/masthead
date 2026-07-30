// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import HeadlineCard from './HeadlineCard';
import { renderComponent, cleanupRendered } from '../test/domTestUtils';

// This fixture deliberately DOES carry a thumbnail URL. The pre-change card
// rendered it as an <img> (a 16/9 hero in the lead variant, an 80px square in
// the compact one), so the "no images" assertions below fail the moment
// thumbnail rendering comes back — they are not vacuously true.
const headlineWithThumbnail = {
  id: 'a1b2c3d4e5f60718',
  title: 'Reserves climb as remittances hold up',
  url: 'https://example.com/story',
  thumbnail: 'https://example.com/lead.jpg',
  sourceId: 'example',
  sourceName: 'Example Times',
  sourceShortName: 'EXT',
  sourceColor: '#c8102e',
  publishedAt: new Date().toISOString(),
  isPaywall: true,
};

function renderCard(props) {
  return renderComponent(
    <MemoryRouter>
      <HeadlineCard headline={headlineWithThumbnail} {...props} />
    </MemoryRouter>
  );
}

describe('HeadlineCard — feed cards carry no article images', () => {
  afterEach(() => {
    cleanupRendered();
  });

  it('renders no image in the lead card even when the headline has a thumbnail', () => {
    const { container } = renderCard({ variant: 'lead' });

    // Proves the card actually mounted, so the img assertion is about a real tree.
    expect(container.textContent).toContain('Reserves climb as remittances hold up');
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('renders no image in a compact card even when the headline has a thumbnail', () => {
    const { container } = renderCard({ variant: 'compact' });

    expect(container.textContent).toContain('Reserves climb as remittances hold up');
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('still renders the source badge and paywall lock, which are not article images', () => {
    const { container } = renderCard({ variant: 'lead' });

    expect(container.textContent).toContain('EXT');
    // The paywall lock is an inline <svg>, never an <img>.
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});
