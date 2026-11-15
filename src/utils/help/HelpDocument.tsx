import React from 'react';
import type { HelpArticle, HelpBlock, HelpImage, HelpInline, HelpLocation } from '../../types/help';
import { getHelpImageUrl } from './assets';
import { resolveHelpLink } from './links.mjs';

export interface HelpDocumentProps {
  article: HelpArticle;
  onNavigate: (location: HelpLocation) => void;
  onExternalLink?: (url: string) => void;
  onImage?: (image: HelpImage) => void;
}

/** A closed React renderer. Raw HTML, handlers and arbitrary image URLs do not exist in the model. */
export function HelpDocument({ article, onNavigate, onExternalLink, onImage }: HelpDocumentProps): React.ReactElement {
  const renderInline = (nodes: HelpInline[]): React.ReactNode => nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return <React.Fragment key={index}>{node.text}</React.Fragment>;
      case 'code': return <code key={index}>{node.text}</code>;
      case 'break': return <br key={index} />;
      case 'strong': return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'emphasis': return <em key={index}>{renderInline(node.children)}</em>;
      case 'delete': return <del key={index}>{renderInline(node.children)}</del>;
      case 'image': {
        const url = getHelpImageUrl(node.path);
        if (!url) return <span className="help-image-missing" key={index}>{node.alt}</span>;
        const image = <img src={url} alt={node.alt} title={node.title} loading="lazy" decoding="async" />;
        return onImage
          ? <button key={index} type="button" className="help-image-button" onClick={() => onImage({ path: node.path, url, alt: node.alt, title: node.title })}>{image}</button>
          : <React.Fragment key={index}>{image}</React.Fragment>;
      }
      case 'link': {
        const target = node.target;
        if (target.kind === 'internal') return <a key={index} href={`#${target.anchor ? `help-heading-${target.anchor}` : `help-article-${target.articleId}`}`} onClick={event => { event.preventDefault(); onNavigate({ articleId: target.articleId, anchor: target.anchor }); }}>{renderInline(node.children)}</a>;
        if (target.kind === 'external') {
          const checked = resolveHelpLink(article.sourcePath, target.url, []);
          if (checked.kind === 'external') return <a key={index} href={checked.url} rel="noopener noreferrer" onAuxClick={event => event.preventDefault()} onClick={event => { event.preventDefault(); onExternalLink?.(checked.url); }}>{renderInline(node.children)}</a>;
        }
        return <span key={index} className="help-link-blocked">{renderInline(node.children)}</span>;
      }
    }
  });
  const renderBlocks = (nodes: HelpBlock[]): React.ReactNode => nodes.map((node, index) => {
    switch (node.type) {
      case 'paragraph': return <p key={index}>{renderInline(node.children)}</p>;
      case 'heading': {
        const heading = `h${Math.min(6, Math.max(1, node.level))}` as keyof React.JSX.IntrinsicElements;
        return React.createElement(heading, { key: index, id: `help-heading-${node.id}`, 'data-help-anchor': node.id }, renderInline(node.children));
      }
      case 'code': return <pre key={index}><code data-language={node.language || undefined}>{node.text}</code></pre>;
      case 'rule': return <hr key={index} />;
      case 'quote': return <blockquote key={index}>{renderBlocks(node.children)}</blockquote>;
      case 'list': {
        const items = node.items.map((item, itemIndex) => <li key={itemIndex}>{item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled readOnly tabIndex={-1} />}{renderBlocks(item.children)}</li>);
        return node.ordered ? <ol key={index} start={node.start}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'table': return <div className="help-table-scroll" key={index}><table><thead><tr>{node.header.map((cell, column) => <th key={column} style={{ textAlign: node.align[column] ?? undefined }} scope="col">{renderInline(cell)}</th>)}</tr></thead><tbody>{node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: node.align[column] ?? undefined }}>{renderInline(cell)}</td>)}</tr>)}</tbody></table></div>;
    }
  });
  return <article className="help-document" id={`help-article-${article.id}`} lang={article.locale}>{renderBlocks(article.blocks)}</article>;
}
