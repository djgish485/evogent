'use client';

import { useEffect, useId, useMemo, useSyncExternalStore, type MouseEventHandler, type PointerEventHandler } from 'react';

export type OverlayDismissPolicy = 'modal' | 'detail';

type OverlayDismissOptions = {
  enabled: boolean;
  onClose: () => void;
  policy?: OverlayDismissPolicy;
  closeOnBackdropPress?: boolean;
  closeOnEscape?: boolean;
};

const overlayDismissPolicyDefaults: Record<OverlayDismissPolicy, { closeOnBackdropPress: boolean; closeOnEscape: boolean }> = {
  modal: {
    closeOnBackdropPress: true,
    closeOnEscape: true,
  },
  detail: {
    closeOnBackdropPress: false,
    closeOnEscape: true,
  },
};

let overlayStack: string[] = [];
const listeners = new Set<() => void>();

function emitOverlayStackChange() {
  for (const listener of listeners) {
    listener();
  }
}

function getTopOverlayId(): string | null {
  return overlayStack[overlayStack.length - 1] ?? null;
}

function registerOverlay(id: string) {
  overlayStack = overlayStack.filter((entry) => entry !== id);
  overlayStack.push(id);
  emitOverlayStackChange();
}

function unregisterOverlay(id: string) {
  const nextStack = overlayStack.filter((entry) => entry !== id);
  if (nextStack.length === overlayStack.length) {
    return;
  }
  overlayStack = nextStack;
  emitOverlayStackChange();
}

function subscribeToOverlayStack(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOverlayDismiss({
  enabled,
  onClose,
  policy = 'modal',
  closeOnBackdropPress,
  closeOnEscape,
}: OverlayDismissOptions) {
  const resolvedOptions = resolveOverlayDismissOptions({
    policy,
    closeOnBackdropPress,
    closeOnEscape,
  });
  const overlayId = useId();
  const topOverlayId = useSyncExternalStore(subscribeToOverlayStack, getTopOverlayId, () => null);
  const isTopmost = enabled && topOverlayId === overlayId;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    registerOverlay(overlayId);
    return () => {
      unregisterOverlay(overlayId);
    };
  }, [enabled, overlayId]);

  useEffect(() => {
    if (!enabled || !resolvedOptions.closeOnEscape || !isTopmost) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [enabled, isTopmost, onClose, resolvedOptions.closeOnEscape]);

  const handleBackdropPointerDown = useMemo<PointerEventHandler<HTMLElement>>(
    () => (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!enabled || !isTopmost || !resolvedOptions.closeOnBackdropPress) {
        return;
      }

      onClose();
    },
    [enabled, isTopmost, onClose, resolvedOptions.closeOnBackdropPress],
  );

  const handleBackdropClick = useMemo<MouseEventHandler<HTMLElement>>(
    () => (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  return {
    isTopmost,
    backdropProps: {
      onPointerDown: handleBackdropPointerDown,
      onClick: handleBackdropClick,
    },
  };
}

export function resolveOverlayDismissOptions({
  policy = 'modal',
  closeOnBackdropPress,
  closeOnEscape,
}: Pick<OverlayDismissOptions, 'policy' | 'closeOnBackdropPress' | 'closeOnEscape'>) {
  const defaults = overlayDismissPolicyDefaults[policy];
  return {
    closeOnBackdropPress: closeOnBackdropPress ?? defaults.closeOnBackdropPress,
    closeOnEscape: closeOnEscape ?? defaults.closeOnEscape,
  };
}

export function __resetOverlayDismissStackForTests() {
  overlayStack = [];
  emitOverlayStackChange();
}

export function __registerOverlayForTests(id: string) {
  registerOverlay(id);
}

export function __unregisterOverlayForTests(id: string) {
  unregisterOverlay(id);
}

export function __getTopOverlayIdForTests() {
  return getTopOverlayId();
}
