'use client';

import { Children, cloneElement, isValidElement, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitSearchHighlightParts } from '@/lib/search-utils';

export const FEED_MARKDOWN_BODY_CLASS_NAME = 'max-w-none text-zinc-200 [&_p]:my-4 [&_p]:text-[17px] [&_p]:leading-[1.45] sm:[&_p]:text-[18px] [&_ul]:my-4 [&_ol]:my-4 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1.5 [&_li]:text-[17px] [&_li]:leading-[1.45] sm:[&_li]:text-[18px] [&_li]:marker:text-zinc-500 [&_strong]:font-semibold [&_strong]:text-zinc-100 [&_em]:text-zinc-100 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-300 [&_blockquote_p]:text-[17px] [&_blockquote_p]:leading-[1.45] sm:[&_blockquote_p]:text-[18px] [&_a]:text-sky-400 [&_a]:underline-offset-2 hover:[&_a]:text-sky-300 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-zinc-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-zinc-100 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:bg-black/35 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_h1]:mt-8 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:leading-tight sm:[&_h1]:text-4xl [&_h2]:mt-8 [&_h2]:text-[22px] [&_h2]:font-semibold [&_h2]:leading-tight sm:[&_h2]:text-[24px] [&_h3]:mt-6 [&_h3]:text-[18px] [&_h3]:font-semibold [&_h3]:leading-tight sm:[&_h3]:text-[20px] [&_h4]:mt-6 [&_h4]:text-[18px] [&_h4]:font-semibold [&_h4]:leading-tight sm:[&_h4]:text-[20px] [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_h4:first-child]:mt-0';

export const FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME = 'max-w-none text-[15px] leading-[1.55] text-zinc-200 [&_p]:my-3 [&_p]:text-[15px] [&_p]:leading-[1.55] [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_li]:text-[15px] [&_li]:leading-[1.55] [&_li]:marker:text-zinc-500 [&_strong]:font-semibold [&_strong]:text-zinc-100 [&_em]:text-zinc-100 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-300 [&_blockquote_p]:my-3 [&_blockquote_p]:text-[15px] [&_blockquote_p]:leading-[1.55] [&_a]:text-sky-400 [&_a]:underline-offset-2 hover:[&_a]:text-sky-300 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-zinc-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-zinc-100 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:bg-black/35 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_h1]:mt-6 [&_h1]:text-[22px] [&_h1]:font-bold [&_h1]:leading-tight [&_h2]:mt-5 [&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:leading-tight [&_h3]:mt-4 [&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:leading-tight [&_h4]:mt-3 [&_h4]:text-[15px] [&_h4]:font-semibold [&_h4]:leading-tight [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_h4:first-child]:mt-0';

export const FEED_MARKDOWN_TIGHT_BODY_CLASS_NAME = 'max-w-none text-sm leading-6 text-zinc-200 [&_p]:my-0 [&_p]:text-sm [&_p]:leading-6 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-0.5 [&_li]:text-sm [&_li]:leading-6 [&_li]:marker:text-zinc-500 [&_strong]:font-semibold [&_strong]:text-zinc-100 [&_em]:text-zinc-100 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-300 [&_blockquote_p]:my-0 [&_blockquote_p]:text-sm [&_blockquote_p]:leading-6 [&_a]:text-sky-400 [&_a]:underline-offset-2 hover:[&_a]:text-sky-300 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-zinc-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-zinc-100 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:bg-black/35 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:leading-tight [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:leading-tight [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:leading-tight [&_h4]:mt-2 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:leading-tight [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_h4:first-child]:mt-0';

export function HighlightedSearchText({ text, searchQuery }: { text: string; searchQuery?: string | null }) {
  const parts = useMemo(() => splitSearchHighlightParts(text, searchQuery), [searchQuery, text]);

  return (
    <>
      {parts.map((part, index) => part.isMatch ? (
        <span
          key={`${index}-${part.text}`}
          data-search-highlight="true"
          className="search-match rounded bg-amber-400/20 px-0.5 text-amber-100"
        >
          {part.text}
        </span>
      ) : (
        <span key={`${index}-${part.text}`}>{part.text}</span>
      ))}
    </>
  );
}

export function highlightReactTextChildren(children: ReactNode, searchQuery?: string | null): ReactNode {
  if (!searchQuery) {
    return children;
  }

  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      return <HighlightedSearchText text={child} searchQuery={searchQuery} />;
    }

    if (isValidElement<{ children?: ReactNode }>(child)) {
      const childChildren = child.props.children;
      if (!childChildren) {
        return child;
      }

      return cloneElement(child, undefined, highlightReactTextChildren(childChildren, searchQuery));
    }

    return child;
  });
}

function withoutMarkdownNode<T extends { node?: unknown }>(props: T): Omit<T, 'node'> {
  const { node, ...domProps } = props;
  void node;
  return domProps;
}

export function createFeedMarkdownComponents(searchQuery?: string | null): Components {
  return {
    a: ({ children, ...rawProps }) => {
      const { href, ...props } = withoutMarkdownNode(rawProps);
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          {...props}
        >
          {highlightReactTextChildren(children, searchQuery)}
        </a>
      );
    },
    p: ({ children, ...rawProps }) => (
      <p {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</p>
    ),
    li: ({ children, ...rawProps }) => (
      <li {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</li>
    ),
    strong: ({ children, ...rawProps }) => (
      <strong {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</strong>
    ),
    em: ({ children, ...rawProps }) => (
      <em {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</em>
    ),
    h1: ({ children, ...rawProps }) => (
      <h1 {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</h1>
    ),
    h2: ({ children, ...rawProps }) => (
      <h2 {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</h2>
    ),
    h3: ({ children, ...rawProps }) => (
      <h3 {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</h3>
    ),
    h4: ({ children, ...rawProps }) => (
      <h4 {...withoutMarkdownNode(rawProps)}>{highlightReactTextChildren(children, searchQuery)}</h4>
    ),
  };
}

export function FeedMarkdown({
  text,
  searchQuery = null,
  className = FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME,
  testId,
}: {
  text: string;
  searchQuery?: string | null;
  className?: string;
  testId?: string;
}) {
  const markdownComponents = useMemo(() => createFeedMarkdownComponents(searchQuery), [searchQuery]);

  return (
    <article data-testid={testId} className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </article>
  );
}
