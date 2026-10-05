import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Button } from '@actual-app/components/button';
import { theme } from '@actual-app/components/theme';
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

// Deliberately native controls rather than the component library's Button:
// react-aria's Button stops propagation itself, so a case built from it passes
// whether or not the card's keydown guard exists.
function CardWithNativeInnerControls() {
  return (
    <ReportCard widgetId="widget-1" to="/reports/net-worth">
      <View>
        <span>Balance Forecast</span>
        <button type="button">Native control</button>
        <input type="text" aria-label="Widget name" defaultValue="March" />
      </View>
    </ReportCard>
  );
}

function getCard() {
  return screen.getByRole('button', { name: /Balance Forecast/ });
}

// The card body is the View ReportCard renders inside the click surface, and it
// is what carries the background and the box-shadow rules — the surface
// deliberately has neither.
function getCardBody() {
  const body = getCard().firstElementChild;
  if (!body) throw new Error('the card rendered no body');
  return body;
}

// Reads a sibling source file and flattens it enough that a claim about a
// comment cannot be satisfied or dodged purely by where the line breaks and
// `//` markers fall.
function readOwnSource(file: string) {
  return readFileSync(path.resolve(import.meta.dirname, file), 'utf8')
    .replaceAll(/^\s*\/\//gm, ' ')
    .replaceAll(/\s+/g, ' ');
}

function dispatchKeyDown(target: Element, key: string, repeat = false) {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key === ' ' ? 'Space' : key,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

// The rules emotion actually injected for an element's classes, including any
// `:hover` variant of them. jsdom resolves none of that in getComputedStyle —
// a hover state does not exist there — so reading the cascade is the only way
// to make the hover assertion falsifiable rather than vacuous.
function injectedCssFor(element: Element) {
  const styleSheetText = Array.from(document.querySelectorAll('style'))
    .map(tag => tag.textContent ?? '')
    .join('\n');

  return (styleSheetText.match(/[^{}]+\{[^{}]*\}/g) ?? [])
    .filter(rule => {
      const selector = rule.slice(0, rule.indexOf('{'));
      return Array.from(element.classList).some(name =>
        selector.includes(`.${name}`),
      );
    })
    .join('\n');
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

  // Fired on a descendant rather than on the surface itself: a click whose
  // target is the surface passes with or without the guard, so it cannot tell
  // this handler from a wrong one. Clicking the card's body text is what a user
  // actually does, and it has to keep navigating.
  it('navigates to the card route when a descendant of the click surface is clicked', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    fireEvent.click(screen.getByText('Balance Forecast'));

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

  it.each(['Enter', ' '])(
    'navigates once and still prevents the default when %j is held down on the focused card',
    async key => {
      renderCard(<CardWithInnerControl />);
      await act(() => Promise.resolve());

      const card = getCard();
      // One real keypress, then the auto-repeats a held key produces. Playwright
      // does not synthesize repeats, which is why QA saw six history entries.
      const events = [
        dispatchKeyDown(card, key),
        ...Array.from({ length: 5 }, () => dispatchKeyDown(card, key, true)),
      ];

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(events.map(event => event.defaultPrevented)).toEqual(
        events.map(() => true),
      );
    },
  );

  it('does not navigate when a keypress starts on a native control inside the widget body', async () => {
    renderCard(<CardWithNativeInnerControls />);
    await act(() => Promise.resolve());

    dispatchKeyDown(
      screen.getByRole('button', { name: 'Native control' }),
      'Enter',
    );

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('leaves a native control inside the widget body free to be activated by its own keypress', async () => {
    renderCard(<CardWithNativeInnerControls />);
    await act(() => Promise.resolve());

    const event = dispatchKeyDown(
      screen.getByRole('button', { name: 'Native control' }),
      'Enter',
    );

    // Preventing default here would suppress the click the browser synthesizes
    // for the inner button, leaving it keyboard-dead. This pins the guard order.
    expect(event.defaultPrevented).toBe(false);
  });

  // The click-side twin of the three keydown cases above: the same controls,
  // activated by click instead of keypress, and the card must stay out of it.
  it('does not navigate when a native control inside the widget body is clicked', async () => {
    renderCard(<CardWithNativeInnerControls />);
    await act(() => Promise.resolve());

    fireEvent.click(screen.getByRole('button', { name: 'Native control' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('leaves a text field inside the widget body alone when it is clicked', async () => {
    renderCard(<CardWithNativeInnerControls />);
    await act(() => Promise.resolve());

    fireEvent.click(screen.getByLabelText('Widget name'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('leaves a space typed into a text field inside the widget body alone', async () => {
    renderCard(<CardWithNativeInnerControls />);
    await act(() => Promise.resolve());

    const event = dispatchKeyDown(screen.getByLabelText('Widget name'), ' ');

    expect(event.defaultPrevented).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('gives the click surface no background, at rest or on hover', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    // An empty read would satisfy the assertion below for the wrong reason —
    // emotion writing CSSOM rules instead of text nodes would silently turn
    // this into a pass. So check the read happened first.
    const surfaceCss = injectedCssFor(getCard());
    expect(surfaceCss).not.toBe('');

    // The affordance is the card body's shadow deepening, not a tint on the
    // surface; reintroducing one would be a new look rather than this fix.
    expect(surfaceCss).not.toMatch(/background(-color)?\s*:/);
  });

  it('gives the card body a themed background and a resting shadow', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    const bodyCss = injectedCssFor(getCardBody());
    expect(bodyCss).not.toBe('');

    expect(bodyCss).toContain(`background-color:${theme.tableBackground}`);
    expect(bodyCss).toMatch(/box-shadow:\s*0 2px 6px/);
  });

  it('deepens the card body shadow on hover', async () => {
    renderCard(<CardWithInnerControl />);
    await act(() => Promise.resolve());

    const bodyCss = injectedCssFor(getCardBody());
    expect(bodyCss).not.toBe('');

    // getComputedStyle cannot see a :hover state in jsdom, so this is the only
    // place the hover claim is checkable at all.
    expect(bodyCss).toMatch(/:hover\s*\{[^{}]*box-shadow:\s*0 4px 6px/);
  });

  it('records the nested-interactive trade in the comment above the surface', () => {
    const source = readOwnSource('ReportCard.tsx');

    // Without a <Button>, role="button" around focusable descendants is itself
    // the nested-interactive shape. Saying so is the point of the comment.
    expect(source).toContain('nested-interactive');
    expect(source).toContain('CalendarCard');
  });
});
