import React from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TestProviders } from '#mocks';

import { CompactFiltersButton } from './CompactFiltersButton';

describe('CompactFiltersButton', () => {
  const renderButton = (onPress = vi.fn()) => {
    render(<CompactFiltersButton onPress={onPress} />, {
      wrapper: TestProviders,
    });
    return onPress;
  };

  it("exposes the accessible name 'Filters'", () => {
    renderButton();

    expect(screen.getByRole('button', { name: 'Filters' })).toBeDefined();
  });

  it('renders no text node, so its appearance is unchanged', () => {
    renderButton();

    // The name comes from aria-label, not from visible text. Rendering text
    // would move every visual-regression snapshot that contains this button.
    expect(screen.getByRole('button', { name: 'Filters' }).textContent).toBe(
      '',
    );
  });

  it('calls onPress when clicked', async () => {
    const user = userEvent.setup();
    const onPress = renderButton();

    await user.click(screen.getByRole('button', { name: 'Filters' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
