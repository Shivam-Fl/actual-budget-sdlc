import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { Button } from '@actual-app/components/button';
import { View } from '@actual-app/components/view';
import { initServer } from '@actual-app/core/platform/client/connection';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MockInstance } from 'vitest';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';

import { ReportCard } from './ReportCard';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const mockNavigate = vi.fn();

vi.mock('#hooks/useNavigate', () => ({
  useNavigate: () => mockNavigate,
}));

// jsdom implements no IntersectionObserver. ReportCard renders no children
// until useIsInViewport reports the card visible, so a no-op stub would render
// an empty card and let every assertion below pass vacuously.
class AlwaysIntersectingObserver {
  private callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this,
    );
  }

  unobserve() {
    // no-op
  }

  disconnect() {
    // no-op
  }

  takeRecords() {
    return [];
  }

  root = null;
  rootMargin = '';
  scrollMargin = '';
  thresholds = [];
}

function renderCard(children: ReactNode) {
  const store = configureTestAppStore({ queryClient: createTestQueryClient() });

  return render(
    <TestProviders store={store}>
      <MemoryRouter>{children}</MemoryRouter>
    </TestProviders>,
  );
}

function CardWithInnerControl({ onInnerClick }: { onInnerClick?: () => void }) {
  return (
    <ReportCard widgetId="widget-1" to="/reports/net-worth">
      <View>
        <span>Balance Forecast</span>
        <Button onPress={onInnerClick}>March</Button>
      </View>
    </ReportCard>
  );
}

describe('ReportCard click surface', () => {
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let originalIntersectionObserver: typeof IntersectionObserver;

  beforeEach(() => {
    originalIntersectionObserver = global.IntersectionObserver;
    global.IntersectionObserver =
      AlwaysIntersectingObserver as unknown as typeof IntersectionObserver;

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    mockNavigate.mockReset();

    initServer({
      query: async () => ({ data: [], dependencies: [] }),
      'get-cell': async () => ({ name: 'test-cell', value: 0 }),
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    global.IntersectionObserver = originalIntersectionObserver;
  });

  function nestingWarnings() {
    return consoleErrorSpy.mock.calls
      .map(args => String(args[0]))
      .filter(
        message =>
          message.includes('cannot be a descendant of') ||
          message.includes('cannot contain a nested'),
      );
  }

  it('renders a card body containing a button without nesting buttons or warning', async () => {
    const { container } = renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(nestingWarnings()).toEqual([]);
    // The card must still expose the inner control
    expect(screen.getByRole('button', { name: 'March' })).toBeInTheDocument();
  });

  it('exposes the card as a focusable role button named from its contents', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    const card = screen.getByRole('button', { name: /Balance Forecast March/ });
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card.tagName).toBe('DIV');
  });

  it('navigates to the card route when the card body is clicked', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    fireEvent.click(
      screen.getByRole('button', { name: /Balance Forecast March/ }),
    );

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/reports/net-worth', {
      state: { goBack: true },
    });
  });

  it.each(['Enter', ' '])(
    'navigates to the card route when %j is pressed on the focused card',
    async key => {
      renderCard(<CardWithInnerControl />);
      await act(() => Promise.resolve());

      fireEvent.keyDown(
        screen.getByRole('button', { name: /Balance Forecast March/ }),
        { key },
      );

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/reports/net-worth', {
        state: { goBack: true },
      });
    },
  );

  it('does not navigate when a control inside the widget body is clicked', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    fireEvent.click(screen.getByRole('button', { name: 'March' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])(
    'does not navigate when %j is pressed on a control inside the widget body',
    async key => {
      renderCard(<CardWithInnerControl />);
      await act(() => Promise.resolve());

      fireEvent.keyDown(screen.getByRole('button', { name: 'March' }), { key });

      expect(mockNavigate).not.toHaveBeenCalled();
    },
  );
});
