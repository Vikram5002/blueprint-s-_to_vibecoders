/**
 * What the Page Builder palette offers: every element type, grouped the way
 * website builders group them, with the size and starter text a freshly
 * dropped element gets and a hint for what its label means.
 *
 * Labels with several parts use `|` (a navbar's "Brand|Home|Pricing"); a
 * table's rows are `|`-separated and its cells `,`-separated - the same
 * convention src/generate/canvas-elements.ts renders.
 */
import type { CanvasElementType } from './page-builder-types';

export interface ElementSpec {
  readonly palette: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** Shown under the Label field; absent when the label is plain text. */
  readonly hint?: string;
}

export const ELEMENT_SPECS: Readonly<Record<CanvasElementType, ElementSpec>> = {
  // Basic
  heading: { palette: 'Heading', label: 'Heading', width: 320, height: 40 },
  text: { palette: 'Text', label: 'Text label', width: 200, height: 24 },
  button: { palette: 'Button', label: 'Click me', width: 160, height: 40 },
  link: { palette: 'Link', label: 'Learn more', width: 140, height: 24 },
  image: { palette: 'Image', label: 'Image', width: 240, height: 160, hint: 'Paste an https:// image URL to show a real image.' },
  input: { palette: 'Text input', label: 'Enter text...', width: 220, height: 36 },
  textarea: { palette: 'Textarea', label: 'Enter a longer message...', width: 220, height: 96 },
  checkbox: { palette: 'Checkbox', label: 'Checkbox option', width: 160, height: 24 },
  radio: { palette: 'Radio', label: 'Radio option', width: 160, height: 24 },
  select: { palette: 'Dropdown', label: 'Option one', width: 200, height: 36 },
  divider: { palette: 'Divider', label: '', width: 400, height: 2 },
  container: { palette: 'Container', label: '', width: 320, height: 200 },
  // Layout
  section: { palette: 'Section', label: 'Section', width: 1200, height: 320 },
  card: { palette: 'Card', label: 'Card title|A short description of this card.|Read more', width: 300, height: 200, hint: 'Title | text | button (optional)' },
  navbar: { palette: 'Navbar', label: 'Brand|Home|Features|Pricing|Contact', width: 1280, height: 64, hint: 'Brand | link | link …' },
  hero: { palette: 'Hero', label: 'Build something great|A one-line pitch for your product.|Get started', width: 1200, height: 360, hint: 'Title | subtitle | button (optional)' },
  footer: { palette: 'Footer', label: '© 2026 Your company|Privacy|Terms|Contact', width: 1280, height: 64, hint: 'Text | link | link …' },
  // Typography
  paragraph: { palette: 'Paragraph', label: 'Write a longer paragraph here. It wraps across lines inside its box.', width: 480, height: 96 },
  quote: { palette: 'Quote', label: 'Simplicity is the ultimate sophistication.|Leonardo da Vinci', width: 480, height: 90, hint: 'Quote | author (optional)' },
  code: { palette: 'Code block', label: 'npm install|npm run dev', width: 420, height: 90, hint: 'Each | starts a new line' },
  list: { palette: 'List', label: 'First item|Second item|Third item', width: 300, height: 100, hint: 'Item | item | item' },
  badge: { palette: 'Badge', label: 'New', width: 64, height: 24 },
  // Media
  video: { palette: 'Video', label: 'Product demo', width: 480, height: 270, hint: 'Paste a YouTube or https:// video URL.' },
  icon: { palette: 'Icon', label: '★', width: 48, height: 48, hint: 'A symbol or emoji, e.g. ⚡ ✓ ♥' },
  avatar: { palette: 'Avatar', label: 'Ada Lovelace', width: 56, height: 56, hint: 'A name - shown as initials' },
  // Forms
  email: { palette: 'Email', label: 'you@example.com', width: 260, height: 40 },
  password: { palette: 'Password', label: 'Password', width: 260, height: 40 },
  number: { palette: 'Number', label: '0', width: 140, height: 40 },
  date: { palette: 'Date', label: 'Date', width: 180, height: 40 },
  search: { palette: 'Search', label: 'Search…', width: 300, height: 40 },
  toggle: { palette: 'Toggle', label: 'Enable notifications', width: 220, height: 28 },
  slider: { palette: 'Slider', label: 'Volume', width: 240, height: 24 },
  file: { palette: 'File upload', label: 'Drop a file or click to upload', width: 300, height: 100 },
  rating: { palette: 'Rating', label: '4|128 reviews', width: 220, height: 32, hint: 'Stars 0-5 | caption (optional)' },
  // Data display
  table: { palette: 'Table', label: 'Name,Role,Status|Ada,Engineer,Active|Alan,Analyst,Away', width: 480, height: 140, hint: 'Rows split by | , cells by comma; first row is the header' },
  stat: { palette: 'Stat', label: '12.4k|Monthly visitors', width: 200, height: 96, hint: 'Value | caption' },
  progress: { palette: 'Progress', label: '65|Profile complete', width: 280, height: 40, hint: 'Percent | caption' },
  pricing: { palette: 'Pricing card', label: 'Pro|$19/mo|Unlimited projects|Priority support|Custom domain', width: 280, height: 320, hint: 'Plan | price | feature | feature …' },
  testimonial: { palette: 'Testimonial', label: 'This tool saved our team hours every week.|Grace Hopper|CTO, Example', width: 360, height: 160, hint: 'Quote | name | role' },
  // Navigation
  tabs: { palette: 'Tabs', label: 'Overview|Features|Reviews', width: 360, height: 44, hint: 'Tab | tab | tab (first is active)' },
  breadcrumb: { palette: 'Breadcrumb', label: 'Home|Products|Details', width: 320, height: 28, hint: 'Crumb | crumb | current page' },
  pagination: { palette: 'Pagination', label: '5', width: 320, height: 40, hint: 'Number of pages (1-9)' },
  // Feedback
  alert: { palette: 'Alert', label: 'Your changes have been saved.', width: 420, height: 48 },
  accordion: { palette: 'Accordion', label: 'How does billing work?|You are billed monthly and can cancel anytime.', width: 480, height: 110, hint: 'Question | answer' },
  spinner: { palette: 'Spinner', label: 'Loading', width: 48, height: 48 },
  // Backgrounds - label is "seed|complexity"; "New shape" in the Inspector picks a new seed
  waves: { palette: 'Waves', label: '12|5', width: 1280, height: 200, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
  'layered-waves': { palette: 'Layered waves', label: '27|6', width: 1280, height: 260, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
  blob: { palette: 'Blob', label: '8|6', width: 320, height: 320, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
  'blob-scene': { palette: 'Blob scene', label: '31|6', width: 1280, height: 400, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
  peaks: { palette: 'Layered peaks', label: '5|5', width: 1280, height: 260, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
  circles: { palette: 'Circle scatter', label: '44|6', width: 1280, height: 400, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
  // Motion
  typewriter: { palette: 'Typewriter', label: 'Build websites that move.', width: 640, height: 64 },
  'text-shimmer': { palette: 'Text shimmer', label: 'Shimmering headline', width: 560, height: 60 },
  'text-scramble': { palette: 'Text scramble', label: 'DECRYPTING...', width: 480, height: 50 },
  'word-reveal': { palette: 'Word reveal', label: 'Every word arrives on its own', width: 640, height: 60 },
  counter: { palette: 'Animated counter', label: '12500|+|Happy customers', width: 260, height: 110, hint: 'Number | suffix | caption' },
  marquee: { palette: 'Marquee', label: 'Acme|Globex|Initech|Umbrella|Hooli', width: 1280, height: 60, hint: 'Item | item | item - scrolls forever' },
  'gradient-border': { palette: 'Gradient border card', label: 'Featured|The border flows around the card.', width: 360, height: 170, hint: 'Title | text' },
  'mesh-gradient': { palette: 'Mesh gradient', label: '19|6', width: 1280, height: 400, hint: 'Seed | complexity 1-10. Use New shape to redraw.' },
};

export interface ElementCategory {
  readonly name: string;
  readonly types: readonly CanvasElementType[];
}

export const ELEMENT_CATEGORIES: readonly ElementCategory[] = [
  { name: 'Layout', types: ['navbar', 'hero', 'section', 'card', 'container', 'divider', 'footer'] },
  { name: 'Text', types: ['heading', 'text', 'paragraph', 'quote', 'list', 'code', 'badge', 'link'] },
  { name: 'Media', types: ['image', 'video', 'icon', 'avatar'] },
  { name: 'Forms', types: ['button', 'input', 'email', 'password', 'number', 'date', 'search', 'textarea', 'select', 'checkbox', 'radio', 'toggle', 'slider', 'file', 'rating'] },
  { name: 'Data', types: ['table', 'stat', 'progress', 'pricing', 'testimonial'] },
  { name: 'Navigation', types: ['tabs', 'breadcrumb', 'pagination'] },
  { name: 'Feedback', types: ['alert', 'accordion', 'spinner'] },
  { name: 'Motion', types: ['typewriter', 'text-shimmer', 'text-scramble', 'word-reveal', 'counter', 'marquee', 'gradient-border'] },
  { name: 'Backgrounds', types: ['waves', 'layered-waves', 'peaks', 'blob', 'blob-scene', 'circles', 'mesh-gradient'] },
];

/** The label split the same way the generator splits it. */
export function labelParts(label: string): string[] {
  return label.split('|').map((part) => part.trim()).filter((part) => part !== '');
}

/** Element types that are form fields - mirrors FIELD_KINDS in src/generate/canvas-form.ts. */
export const FIELD_TYPES: ReadonlySet<CanvasElementType> = new Set<CanvasElementType>([
  'input', 'textarea', 'select', 'search', 'email', 'password', 'number', 'slider', 'date', 'checkbox', 'radio', 'toggle',
]);

/** The field name the generator derives from a label when none is set - same rule as canvas-form.ts. */
export function derivedFieldName(label: string, type: CanvasElementType): string {
  const words = label.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return type;
  const joined = words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join('');
  return (/^[A-Za-z]/.test(joined) ? joined : `field${joined}`).slice(0, 40);
}
