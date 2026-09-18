import { describe, expect, it } from 'vitest';
import { extractLayoutFromComponent } from './extract-layout.js';
import { CANVAS_HEIGHT, CANVAS_WIDTH, validatePageLayout } from './canvas-layout.js';

// The shape of a real model-written frontend page from a live run: a
// heading, a fetched list rendered by map(), a form, and a submit button.
const PRODUCT_CATALOG = `
import { useEffect, useState } from "react";

export function ProductCatalog(): JSX.Element {
  const [products, setProducts] = useState<Product[]>([]);
  return (
    <div className="catalog">
      <h1>Product Catalog</h1>
      <p>Browse {products.length} items</p>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            <img src={product.imageUrl} alt={product.name} />
            <h3>{product.name}</h3>
            <span>{formatPrice(product.price)}</span>
            <a href={\`/products/\${product.id}\`}>View details</a>
          </li>
        ))}
      </ul>
      <hr />
      <form onSubmit={handleSubmit}>
        <input type="text" placeholder="Search products" value={query} />
        <label><input type="checkbox" checked={inStock} /> In stock only</label>
        <select value={sort}><option value="asc">Price: low to high</option></select>
        <input type="hidden" name="csrf" />
        <button type="submit">Search</button>
      </form>
    </div>
  );
}
`;

describe('extractLayoutFromComponent', () => {
  it('inventories the visible elements in reading order with readable placeholders for dynamic text', () => {
    const layout = extractLayoutFromComponent(PRODUCT_CATALOG, 'Product Catalog', 'run-1:frontend/src/pages/product-catalog.tsx');

    expect(layout.pageName).toBe('Product Catalog');
    expect(layout.elements.map((e) => [e.type, e.label])).toEqual([
      ['heading', 'Product Catalog'],
      ['text', 'Browse Length items'],
      ['image', 'Name'],
      ['heading', 'Name'],
      ['link', 'View details'],
      ['divider', ''],
      ['input', 'Search products'],
      ['checkbox', 'In stock only'],
      ['select', 'Price: low to high'],
      ['button', 'Search'],
    ]);
  });

  it('produces a layout the real validator accepts, stacked top to bottom in one column', () => {
    const layout = extractLayoutFromComponent(PRODUCT_CATALOG, 'Product Catalog', 'x');
    expect(validatePageLayout(layout)).toEqual([]);
    const ys = layout.elements.map((e) => e.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(layout.elements.map((e) => e.x)).size).toBe(1);
  });

  it('flows into a second column when the first is full, and never places anything outside the canvas', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i}</p>`).join('\n');
    const layout = extractLayoutFromComponent(`<div>${many}</div>`, 'Long', 'x');
    expect(validatePageLayout(layout)).toEqual([]);
    expect(new Set(layout.elements.map((e) => e.x)).size).toBe(2);
    expect(layout.elements.every((e) => e.x + e.width <= CANVAS_WIDTH && e.y + e.height <= CANVAS_HEIGHT)).toBe(true);
    // 40 paragraphs do not fit in two columns of a fixed canvas - the rest are dropped, never squeezed out of bounds.
    expect(layout.elements.length).toBeLessThan(40);
  });

  it('returns an empty layout for a page with nothing the canvas can represent', () => {
    expect(extractLayoutFromComponent('export function X() { return null; }', 'X', 'x').elements).toEqual([]);
  });
});
