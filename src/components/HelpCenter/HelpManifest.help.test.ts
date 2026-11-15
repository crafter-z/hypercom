import { describe, expect, it } from 'vitest';
import { getHelpImageUrl, helpManifest } from '../../utils/help';
import type { HelpBlock, HelpInline } from '../../types/help';

const EXPECTED_IDS = [
  'home', 'quick-start', 'ports', 'terminal', 'transmission', 'logging',
  'timeline', 'rules', 'tools', 'settings', 'plugins', 'shortcuts',
];

function walkInline(nodes: HelpInline[], visit: (node: HelpInline) => void): void {
  for (const node of nodes) {
    visit(node);
    if ('children' in node) walkInline(node.children, visit);
  }
}

function walkBlocks(blocks: HelpBlock[], visit: (node: HelpInline) => void): void {
  for (const block of blocks) {
    if ('children' in block && Array.isArray(block.children)) {
      if (block.type === 'quote') walkBlocks(block.children, visit);
      else walkInline(block.children, visit);
    }
    if (block.type === 'list') {
      for (const item of block.items) walkBlocks(item.children, visit);
    }
    if (block.type === 'table') {
      block.header.forEach(row => walkInline(row, visit));
      block.rows.forEach(row => row.forEach(cell => walkInline(cell, visit)));
    }
  }
}

describe('built-in Help manifest quality gate', () => {
  it('contains the stable article catalog and one locale', () => {
    expect(helpManifest.version).toBe(1);
    expect(helpManifest.locale).toBe('zh-CN');
    expect(helpManifest.homeId).toBe('home');
    expect(helpManifest.articles.map(article => article.id)).toEqual(EXPECTED_IDS);
    for (const article of helpManifest.articles) {
      expect(article.locale).toBe(helpManifest.locale);
      expect(article.sourcePath).toMatch(/^docs\/userwiki\/.+\.md$/);
      expect(article.headings.length).toBeGreaterThan(0);
      expect(article.searchText.length).toBeGreaterThan(0);
    }
  });

  it('contains only resolved internal links, safe external links and bundled images', () => {
    for (const article of helpManifest.articles) {
      walkBlocks(article.blocks, node => {
        if (node.type === 'link') {
          const target = node.target;
          if (target.kind === 'internal') {
            const targetArticle = helpManifest.articles.find(candidate => candidate.id === target.articleId);
            expect(targetArticle).toBeDefined();
            if (target.anchor) expect(targetArticle!.headings.some(heading => heading.id === target.anchor)).toBe(true);
          } else if (target.kind === 'external') {
            expect(target.url).toMatch(/^(?:https?:|mailto:)/);
          } else {
            throw new Error(`blocked Help link in ${article.id}: ${target.reason}`);
          }
        }
        if (node.type === 'image') {
          expect(getHelpImageUrl(node.path)).toBeTruthy();
        }
      });
    }
  });
});
