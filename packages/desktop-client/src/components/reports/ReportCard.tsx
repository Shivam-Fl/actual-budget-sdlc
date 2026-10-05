import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgDotsHorizontalTriple } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { useContextMenu } from '#hooks/useContextMenu';
import { useIsInViewport } from '#hooks/useIsInViewport';
import { useNavigate } from '#hooks/useNavigate';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';
import {
  useCopyDashboardWidgetMutation,
  useRemoveDashboardWidgetMutation,
} from '#reports/mutations';

import { NON_DRAGGABLE_AREA_CLASS_NAME } from './constants';

// Everything a click can land on that owns the click itself. Used to tell a
// card click apart from a click on a control the widget body rendered.
const INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="tab"]',
  '[role="menuitem"]',
].join(',');

type ReportCardProps = {
  widgetId: string;
  isEditing?: boolean;
  disableClick?: boolean;
  to?: string;
  children: ReactNode;
  size?: number;
  style?: CSSProperties;
  onRename?: () => void;
  contextMenuTriggerRef?: RefObject<HTMLDivElement | null>;
};

export function ReportCard({
  widgetId,
  isEditing,
  disableClick,
  to,
  children,
  size = 1,
  style,
  onRename,
  contextMenuTriggerRef,
}: ReportCardProps) {
  const ref = useRef(null);
  const isInViewport = useIsInViewport(ref);
  const [hasRendered, setHasRendered] = useState(false);
  const navigate = useNavigate();
  const { isNarrowWidth } = useResponsive();
  const containerProps = {
    flex: isNarrowWidth ? '1 1' : `0 0 calc(${size * 100}% / 3 - 20px)`,
  };

  useEffect(() => {
    if (isInViewport && !hasRendered) {
      setHasRendered(true);
    }
  }, [isInViewport, hasRendered]);

  const layoutProps = {
    isEditing,
    widgetId,
    onRename,
    contextMenuTriggerRef,
  };

  const content = (
    <View
      ref={ref}
      style={{
        backgroundColor: theme.tableBackground,
        borderBottomLeftRadius: 2,
        borderBottomRightRadius: 2,
        width: '100%',
        height: '100%',
        boxShadow: '0 2px 6px rgba(0, 0, 0, .15)',
        transition: 'box-shadow .25s',
        ...(isEditing
          ? {
              '& .recharts-surface:hover': {
                cursor: 'move',
                ':active': { cursor: 'grabbing' },
              },
              ':active': { cursor: 'grabbing' },
              filter: 'grayscale(1)',
            }
          : {
              '& .recharts-surface:hover': {
                cursor: 'pointer',
              },
            }),
        ':hover': {
          ...(to ? { boxShadow: '0 4px 6px rgba(0, 0, 0, .15)' } : null),
          ...(isEditing ? { cursor: 'move', filter: 'grayscale(0)' } : null),
        },
        ...(to ? null : containerProps),
        ...style,
      }}
    >
      {/* we render the content only if it is in the viewport
      this reduces the amount of concurrent server api calls and thus
      has a better performance */}
      {isInViewport || hasRendered ? children : null}
    </View>
  );

  if (to && !isEditing && !disableClick) {
    const goToReport = () => {
      void navigate(to, { state: { goBack: true } });
    };

    // Deliberately not a <Button>: the card is a wrapper around widget bodies,
    // and some of them render their own buttons. A <button> here puts a button
    // inside a button, which is invalid HTML and trips React's
    // validateDOMNesting. A View with role="button" keeps the click target and
    // the contents-derived accessible name the e2e selectors rely on.
    //
    // That trades one nesting problem for another rather than removing it:
    // role="button" with tabIndex={0} wrapping focusable descendants is the
    // same nested-interactive shape, so this removed an HTML-validity error
    // and left a semantic one. CalendarCard is the case that makes it visible —
    // its month label is a focusable control inside a focusable card. Fixing it
    // properly means restructuring so the card is not itself a button, which
    // would change the click target and accessible name the e2e selectors
    // depend on; that is a larger change than this one.
    return (
      <Layout {...layoutProps}>
        <View
          role="button"
          tabIndex={0}
          onClick={e => {
            // The keydown guard below asks "did this keypress start on a
            // descendant control?", which works because a keydown can only ever
            // start on a focusable element. A click can start anywhere, so the
            // same question has to be asked differently: did this click land on
            // something interactive? Comparing e.target to e.currentTarget
            // instead would suppress every ordinary card click, because a user's
            // target is the body View, a span, or a chart node rather than the
            // surface itself.
            const target = e.target;
            const interactive =
              target instanceof Element
                ? target.closest(INTERACTIVE_SELECTOR)
                : null;
            // The currentTarget comparison is load-bearing: the surface carries
            // role="button" and so matches INTERACTIVE_SELECTOR itself. Without
            // this check the card would block its own clicks.
            if (interactive && interactive !== e.currentTarget) return;
            goToReport();
          }}
          onKeyDown={e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            // A keypress that starts on a control inside the widget body is
            // that control's, not the card's. This check has to come before
            // preventDefault(): preventing a native descendant control's
            // keydown suppresses the click the browser synthesizes for it,
            // which would leave that control keyboard-dead.
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            // One press, one navigation, however long the key is held.
            if (e.repeat) return;
            goToReport();
          }}
          style={{
            height: '100%',
            width: '100%',
            textAlign: 'left',
            overflow: 'visible',
            cursor: 'pointer',
          }}
        >
          {content}
        </View>
      </Layout>
    );
  }

  return <Layout {...layoutProps}>{content}</Layout>;
}

type LayoutProps = {
  children: ReactNode;
} & Pick<
  ReportCardProps,
  'isEditing' | 'widgetId' | 'onRename' | 'contextMenuTriggerRef'
>;

function Layout({
  children,
  isEditing,
  widgetId,
  onRename,
  contextMenuTriggerRef,
}: LayoutProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const internalViewRef = useRef<HTMLDivElement>(null);
  const viewRef = contextMenuTriggerRef || internalViewRef;

  const removeDashboardWidgetMutation = useRemoveDashboardWidgetMutation();
  const copyDashboardWidgetMutation = useCopyDashboardWidgetMutation();

  useContextMenu({
    triggerRef: viewRef,
    items: [
      onRename && {
        name: 'rename',
        text: t('Rename'),
        onClick: onRename,
        order: 1,
      },
      {
        name: 'remove',
        text: t('Remove'),
        onClick: () => removeDashboardWidgetMutation.mutate({ id: widgetId }),
        order: 1,
      },
      {
        name: 'copy',
        text: t('Copy to dashboard'),
        onClick: () => {
          dispatch(
            pushModal({
              modal: {
                name: 'copy-widget-to-dashboard',
                options: {
                  onSelect: targetDashboardId => {
                    copyDashboardWidgetMutation.mutate({
                      id: widgetId,
                      targetDashboardPageId: targetDashboardId,
                    });
                  },
                },
              },
            }),
          );
        },
        order: 1,
      },
    ],
  });

  return (
    <View
      ref={viewRef}
      style={{
        display: 'block',
        height: '100%',
        '& .hover-visible': {
          opacity: 0,
          transition: 'opacity .25s',
        },
        '&:hover .hover-visible': {
          opacity: 1,
        },
      }}
    >
      {isEditing && (
        <View
          className={['hover-visible', NON_DRAGGABLE_AREA_CLASS_NAME].join(' ')}
          style={{
            position: 'absolute',
            top: 7,
            right: 3,
            zIndex: 1,
          }}
        >
          <Button
            ref={triggerRef}
            variant="bare"
            aria-label={t('Menu')}
            onPress={() => {
              if (viewRef.current) {
                const rect = triggerRef.current?.getBoundingClientRect();
                const clientX = rect ? rect.left : 0;
                const clientY = rect ? rect.bottom : 0;
                viewRef.current.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    clientX,
                    clientY,
                  }),
                );
              }
            }}
          >
            <SvgDotsHorizontalTriple
              width={15}
              height={15}
              style={{ transform: 'rotateZ(90deg)' }}
            />
          </Button>
        </View>
      )}

      {children}
    </View>
  );
}
