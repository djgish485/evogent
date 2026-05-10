'use client';

import type { ComponentType } from 'react';
import { Action } from './primitives/Action';
import { Avatar } from './primitives/Avatar';
import { BarChart } from './primitives/BarChart';
import { Bullet } from './primitives/Bullet';
import { CollapsedCount } from './primitives/CollapsedCount';
import { KeyValue } from './primitives/KeyValue';
import { LinkOut } from './primitives/LinkOut';
import { MetricRing } from './primitives/MetricRing';
import { Paragraph } from './primitives/Paragraph';
import { Pill } from './primitives/Pill';
import { Row } from './primitives/Row';
import { Section } from './primitives/Section';
import { Sparkline } from './primitives/Sparkline';
import { TrendArrow } from './primitives/TrendArrow';
import { cn, type A2UIPrimitiveComponentProps } from './shared';
import type { A2UIActionEvent, A2UINode } from './types';

const catalog: Record<string, ComponentType<A2UIPrimitiveComponentProps>> = {
  Section,
  Paragraph,
  KeyValue,
  Bullet,
  Pill,
  Avatar,
  Row,
  LinkOut,
  Action,
  Sparkline,
  BarChart,
  MetricRing,
  TrendArrow,
  CollapsedCount,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isA2UINode(value: unknown): value is A2UINode {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.type === 'string';
}

function normalizeProps(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function UnknownNode({ node }: { node: A2UINode }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
      Unknown A2UI node type: {node.type}
    </div>
  );
}

function InvalidNode() {
  return (
    <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/30 dark:text-rose-200">
      Invalid A2UI node
    </div>
  );
}

function RenderNode({
  node,
  onAction,
}: {
  node: unknown;
  onAction?: (event: A2UIActionEvent) => void | Promise<void>;
}) {
  if (!isA2UINode(node)) {
    return <InvalidNode />;
  }

  const Component = catalog[node.type];
  if (!Component) {
    return <UnknownNode node={node} />;
  }

  const childNodes = Array.isArray(node.children) ? node.children : [];
  const children = childNodes.map((child, index) => (
    <RenderNode
      key={isA2UINode(child) ? child.id : `${node.id}-invalid-${index}`}
      node={child}
      onAction={onAction}
    />
  ));

  return (
    <Component node={node} props={normalizeProps(node.props)} onAction={onAction}>
      {children}
    </Component>
  );
}

export function A2UIRenderer({
  tree,
  onAction,
  className,
}: {
  tree: A2UINode;
  onAction?: (event: A2UIActionEvent) => void | Promise<void>;
  className?: string;
}) {
  return (
    <div data-testid="a2ui-renderer" className={cn('min-w-0 space-y-3 text-zinc-900 dark:text-zinc-100', className)}>
      <RenderNode node={tree} onAction={onAction} />
    </div>
  );
}
