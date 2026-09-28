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
  // Content and data
  carousel: { palette: 'Carousel', label: 'Welcome|Fast builds|Ship today', width: 640, height: 280, hint: 'Slides split by | - text, or https:// image URLs' },
  gallery: { palette: 'Image gallery', label: 'img|img|img|img', width: 640, height: 200, hint: 'Images split by | (https:// URLs) - click opens a lightbox' },
  lightbox: { palette: 'Lightbox image', label: 'https://', width: 320, height: 200, hint: 'One https:// image URL - click to enlarge' },
  'before-after': { palette: 'Before / after', label: 'before|after', width: 480, height: 280, hint: 'Before image URL | after image URL' },
  map: { palette: 'Map', label: 'Mumbai', width: 480, height: 280, hint: 'A place or address' },
  embed: { palette: 'Embed (iframe)', label: 'https://', width: 480, height: 280, hint: 'An https:// page to embed' },
  'custom-html': { palette: 'Custom HTML', label: '<b>Hello</b>', width: 400, height: 120, hint: 'Inserted exactly as typed - trusted snippets only' },
  audio: { palette: 'Audio player', label: 'https://|Episode title', width: 360, height: 70, hint: 'https:// audio URL | title' },
  lottie: { palette: 'Lottie animation', label: 'https://', width: 200, height: 200, hint: 'https:// Lottie .json URL' },
  'social-icons': { palette: 'Social icons', label: 'github|linkedin|x|instagram|youtube', width: 260, height: 44, hint: 'github, linkedin, x, instagram, youtube, facebook, whatsapp - or full URLs' },
  'logo-cloud': { palette: 'Logo cloud', label: 'Acme|Globex|Initech|Umbrella|Hooli', width: 900, height: 60 },
  'feature-grid': { palette: 'Feature grid', label: '⚡|Fast|Loads instantly|🔒|Secure|Encrypted|🧩|Simple|No setup', width: 900, height: 140, hint: 'Icon | title | text, repeated' },
  'faq-list': { palette: 'FAQ list', label: 'How much does it cost?|It is free to start.|Can I cancel?|Anytime.', width: 600, height: 180, hint: 'Question | answer, repeated' },
  'cta-banner': { palette: 'CTA banner', label: 'Ready to build?|Start free today.|Get started', width: 1100, height: 120, hint: 'Title | text | button' },
  'team-card': { palette: 'Team member', label: 'Ada Lovelace|Founder|Loves engines.', width: 240, height: 220, hint: 'Name | role | bio' },
  'blog-card': { palette: 'Blog card', label: 'Shipping fast|How we ship daily.|Oct 2026', width: 300, height: 280, hint: 'Title | excerpt | date | image URL (optional)' },
  'product-card': { palette: 'Product card', label: 'Sneakers|₹2,499', width: 240, height: 280, hint: 'Name | price | image URL (optional)' },
  'bar-chart': { palette: 'Bar chart', label: 'Jan 12|Feb 19|Mar 8|Apr 24', width: 420, height: 220, hint: 'Label value | label value …' },
  'line-chart': { palette: 'Line chart', label: 'Mon 3|Tue 7|Wed 5|Thu 9|Fri 12', width: 420, height: 220, hint: 'Label value | label value …' },
  'pie-chart': { palette: 'Pie chart', label: 'Direct 45|Search 30|Social 25', width: 420, height: 200, hint: 'Label value | label value …' },
  'description-list': { palette: 'Description list', label: 'Plan: Pro|Seats: 5|Renews: 1 Nov', width: 420, height: 130, hint: 'Key: value | key: value …' },
  'tree-view': { palette: 'Tree view', label: 'src|-components|--Button.tsx|-index.ts', width: 300, height: 140, hint: 'Items split by |, a leading - per level' },
  kanban: { palette: 'Kanban board', label: 'To do: Design, Copy|Doing: Build|Done: Plan', width: 640, height: 220, hint: 'Column: card, card | column: card …' },
  calendar: { palette: 'Calendar', label: '2026-10|5,12,20', width: 320, height: 280, hint: 'YYYY-MM | highlighted days' },
  timeline: { palette: 'Timeline', label: '2024 Founded|2025 Launched|2026 1M users', width: 320, height: 180, hint: 'When what | when what …' },
  stepper: { palette: 'Stepper', label: 'Account|*Details|Payment|Done', width: 640, height: 44, hint: 'Steps split by |; mark the current one with *' },
  kbd: { palette: 'Keyboard key', label: 'Ctrl+K', width: 140, height: 30, hint: 'Keys joined with +' },
  skeleton: { palette: 'Skeleton loader', label: '', width: 320, height: 100 },
  'empty-state': { palette: 'Empty state / 404', label: '📭|Nothing here yet|Create your first project|New project', width: 400, height: 220, hint: 'Icon | title | text | button (optional)' },
  countdown: { palette: 'Countdown', label: '2027-01-01T00:00|Launch in', width: 360, height: 100, hint: 'Target date/time | caption' },
  'qr-code': { palette: 'QR code', label: 'https://example.com', width: 160, height: 160, hint: 'Any text or URL (up to ~200 characters)' },
  // Form widgets - every one is a real field of the page's form
  'radio-group': { palette: 'Radio group', label: 'Plan|Free|Pro|Team', width: 280, height: 120, hint: 'Question | option | option …' },
  'checkbox-group': { palette: 'Checkbox group', label: 'Interests|Design|Code|Marketing', width: 280, height: 120, hint: 'Question | option | option … - submits a list' },
  segmented: { palette: 'Segmented control', label: 'Monthly|Yearly', width: 260, height: 44, hint: 'Option | option …' },
  time: { palette: 'Time', label: 'Time', width: 180, height: 40 },
  'date-range': { palette: 'Date range', label: 'Check-in|Check-out', width: 420, height: 64, hint: 'From label | To label - submits <name>From and <name>To' },
  'color-input': { palette: 'Colour picker', label: 'Pick a colour', width: 220, height: 40 },
  phone: { palette: 'Phone', label: '+91 98765 43210', width: 240, height: 40 },
  url: { palette: 'URL', label: 'https://example.com', width: 300, height: 40 },
  'multi-select': { palette: 'Multi-select', label: 'Tags|Alpha|Beta|Gamma', width: 260, height: 110, hint: 'Label | option | option … - submits a list' },
  'tag-input': { palette: 'Tag input', label: 'Add tags…', width: 420, height: 44, hint: 'Type a tag and press Enter' },
  otp: { palette: 'OTP code', label: 'Verification code', width: 260, height: 56 },
  newsletter: { palette: 'Newsletter signup', label: 'Get the newsletter|you@example.com|Subscribe', width: 520, height: 90, hint: 'Title | placeholder | button' },
  signature: { palette: 'Signature pad', label: 'Sign here', width: 420, height: 170 },
  'rich-text': { palette: 'Rich text', label: 'Write something…', width: 520, height: 180 },
  // Widgets - layout, navigation, overlays, page-level
  columns: { palette: 'Columns', label: 'Column 1|Column 2|Column 3', width: 960, height: 200, hint: 'One title per column, split by |' },
  spacer: { palette: 'Spacer', label: '', width: 400, height: 48 },
  sidebar: { palette: 'Sidebar', label: 'Admin|Dashboard|Projects|Team|Settings', width: 240, height: 480, hint: 'Brand | item | item … (first item is active)' },
  'mobile-menu': { palette: 'Mobile menu', label: 'Brand|Home|About|Contact', width: 1280, height: 56, hint: 'Brand | link | link - opens as a drawer' },
  modal: { palette: 'Modal / dialog', label: 'Open dialog|Dialog title|What the dialog says.', width: 200, height: 48, hint: 'Button text | title | body' },
  tooltip: { palette: 'Tooltip', label: 'Hover for help|Helpful tip text', width: 200, height: 28, hint: 'Text | tooltip' },
  'dropdown-menu': { palette: 'Dropdown menu', label: 'Account|Profile|Settings|Sign out', width: 180, height: 44, hint: 'Button | item | item …' },
  toast: { palette: 'Toast', label: 'Saved successfully', width: 300, height: 48, hint: 'Shown bottom-left for a few seconds after the page loads' },
  'back-to-top': { palette: 'Back to top', label: '↑', width: 44, height: 44, hint: 'Fixed bottom-right of the window' },
  'scroll-progress': { palette: 'Scroll progress', label: '', width: 1280, height: 4, hint: 'A bar across the top of the window that fills as you scroll' },
  fab: { palette: 'Floating button', label: '+', width: 56, height: 56, hint: 'Fixed bottom-right of the window' },
  'cookie-banner': { palette: 'Cookie banner', label: 'We use cookies to improve your experience.|Accept', width: 1200, height: 60, hint: 'Text | button - remembered once accepted' },
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
  { name: 'Layout', types: ['navbar', 'hero', 'section', 'columns', 'card', 'container', 'spacer', 'divider', 'footer'] },
  { name: 'Text', types: ['heading', 'text', 'paragraph', 'quote', 'list', 'code', 'badge', 'link'] },
  { name: 'Media', types: ['image', 'video', 'icon', 'avatar', 'carousel', 'gallery', 'lightbox', 'before-after', 'map', 'embed', 'audio', 'lottie', 'qr-code', 'custom-html'] },
  { name: 'Marketing', types: ['feature-grid', 'cta-banner', 'logo-cloud', 'faq-list', 'team-card', 'blog-card', 'product-card', 'social-icons'] },
  { name: 'Forms', types: ['button', 'input', 'email', 'password', 'number', 'phone', 'url', 'date', 'date-range', 'time', 'search', 'textarea', 'rich-text', 'select', 'multi-select', 'checkbox', 'checkbox-group', 'radio', 'radio-group', 'segmented', 'toggle', 'slider', 'color-input', 'tag-input', 'otp', 'file', 'signature', 'rating', 'newsletter'] },
  { name: 'Data', types: ['table', 'stat', 'progress', 'pricing', 'testimonial', 'bar-chart', 'line-chart', 'pie-chart', 'description-list', 'tree-view', 'kanban', 'calendar', 'timeline', 'stepper', 'countdown', 'kbd', 'skeleton', 'empty-state'] },
  { name: 'Navigation', types: ['sidebar', 'mobile-menu', 'dropdown-menu', 'tabs', 'breadcrumb', 'pagination'] },
  { name: 'Overlays', types: ['modal', 'tooltip', 'toast'] },
  { name: 'Page', types: ['back-to-top', 'scroll-progress', 'fab', 'cookie-banner'] },
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
  'radio-group', 'checkbox-group', 'segmented', 'time', 'date-range', 'color-input', 'phone', 'url', 'multi-select', 'tag-input', 'otp', 'newsletter', 'signature', 'rich-text',
]);

/** The field name the generator derives from a label when none is set - same rule as canvas-form.ts. */
export function derivedFieldName(label: string, type: CanvasElementType): string {
  const words = label.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return type;
  const joined = words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join('');
  return (/^[A-Za-z]/.test(joined) ? joined : `field${joined}`).slice(0, 40);
}
